"""Completion from any work view (`front_desk` p4 step 1).

Fixtures only. What is pinned: each supported root kind draws its own
boundary — an ordinary Front conversation, one run of a routine, an Autolab
`workplan-`, a Forge `assetplan-` — through the same walk and the same
ownership rule the Front Desk uses; an execution topic names its parent
instead of closing it; nested delegation is owned to the bottom; another
request reached by a link stays outside, whatever kind it is; a routine's
previous-run reference and standing request are context and never targets;
a resolved intermediate is walked through; and the two topics whose ✔ means
something else are never roots.
"""

import json
import threading
from http.client import HTTPConnection

import pytest

from agentroom.close import BLOCKED, DONE, READY, Closer, parse_key, plan_actions
from agentroom.closing import (
    ASSETPLAN, ASSETRUN, DESK, FRONT, INTRO, ROUTINE_RUN, ROUTINE_STANDING, TOPIC, WORKPLAN,
    WORKRUN, classify, discover,
)
from agentroom.room import Room
from agentroom.routines import fire_line, run_topic
from agentroom.server import build_server

from test_close import WritingRealm, closer, open_chain, writing_board
from test_closing import (
    AUTOLAB_BOT, DESK_TOPIC, DEVELOPER, FORGE_BOT, FREEFORGE, GHTRENDS, MISSION, ROOT, TASK,
    Realm, board, chain_realm, issue, post, selfnote,
)

FRONT_TOPIC = "front-ask-20260909-0900"
ROUTINE = "ghtrends"
STAMP, EARLIER = "2026-09-09T01:00Z", "2026-09-08T01:00Z"
RUN_TOPIC, EARLIER_TOPIC = run_topic(ROUTINE, STAMP), run_topic(ROUTINE, EARLIER)
STANDING = f"routine-{ROUTINE}"


def topic_keys(found):
    return [(node.channel, node.topic) for node in found.topics]


def excluded_of(found, topic):
    return next(row for row in found.excluded if row["topic"] == topic)


# --- what a conversation is -----------------------------------------------------


def test_a_conversation_is_classified_by_its_channel_and_bare_name():
    assert classify("front", DESK_TOPIC) == DESK
    assert classify("front", f"✔ {DESK_TOPIC}") == DESK
    assert classify("front", FRONT_TOPIC) == FRONT
    assert classify("front", RUN_TOPIC) == ROUTINE_RUN
    assert classify("front", STANDING) == ROUTINE_STANDING
    assert classify("front", "front-routine-ghtrends") == FRONT  # the pre-p7 shared topic
    assert classify("pj-ghtrends", "workplan-trend8") == WORKPLAN
    assert classify("work-g-17", "workrun-task1-g-17") == WORKRUN
    assert classify("agforge-agstudio1", "assetplan-robot") == ASSETPLAN
    assert classify("agforge-agstudio1", "assetrun-robot") == ASSETRUN
    assert classify("agents", "intro-agforge-agstudio1") == INTRO
    assert classify("agautolab-agstudio1", "how is the board") == TOPIC
    assert classify("front", "something else") == TOPIC


# --- each supported root -----------------------------------------------------------


def test_an_ordinary_front_conversation_is_a_root_with_the_whole_chain():
    """The same delegated shape as the Front Desk's, anchored to a `front-*`
    topic Front opened for a chat request rather than for the desk."""
    realm = chain_realm(histories={
        ("front", FRONT_TOPIC): [
            post(1, "Please cover a new trending repo.", sender_id=DEVELOPER, sender="Developer"),
            selfnote(2, "served", "pj-ghtrends/workplan-trend8 1"),
            post(4, "Done — G-18 is written up."),
        ],
        ("pj-ghtrends", "workplan-trend8"): [
            selfnote(10, "rootchat", f"front/{FRONT_TOPIC}"),
            post(11, "Planned as G-17.", sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
        ],
    })
    found = discover({}, ("front", FRONT_TOPIC), realm=realm, plane=board())
    assert found.scope.kind == FRONT and found.scope.closable
    assert "whole Front conversation" in found.scope.description
    assert topic_keys(found) == [
        ("front", FRONT_TOPIC), ("pj-ghtrends", "workplan-trend8"),
        ("work-g-17", "workrun-task1-g-17"),
        ("agforge-agstudio1", "assetplan-robot"), ("agforge-agstudio1", "assetrun-robot"),
    ]
    assert {work.label for work in found.works} == {"G-17", "G-18", "F2-28"}
    assert [row["channel"] for row in found.channels if row["archivable"]] == ["work-g-17"]


def routine_realm(**kwargs):
    """One run of a routine, with the run before it and the standing request
    all on the realm, each with work of its own."""
    histories = {
        ("front", STANDING): [
            post(100, "Summarise trending repos.", sender_id=DEVELOPER, sender="Developer"),
        ],
        ("front", RUN_TOPIC): [
            post(200, fire_line(ROUTINE, STAMP, previous=EARLIER_TOPIC),
                 sender_id=DEVELOPER, sender="Developer"),
            selfnote(201, "served", "pj-ghtrends/workplan-trend8 1"),
            post(202, "Done — G-18 is written up."),
        ],
        ("pj-ghtrends", "workplan-trend8"): [
            selfnote(10, "rootchat", f"front/{RUN_TOPIC}"),
            post(11, "Planned as G-17.", sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
        ],
        ("front", f"✔ {EARLIER_TOPIC}"): [
            post(150, fire_line(ROUTINE, EARLIER), sender_id=DEVELOPER, sender="Developer"),
            selfnote(151, "served", "pj-ghtrends/workplan-trend7 1"),
            post(152, "Done — G-16 is written up."),
        ],
        ("pj-ghtrends", "✔ workplan-trend7"): [
            selfnote(20, "rootchat", f"front/{EARLIER_TOPIC}"),
            post(21, "Planned as G-15.", sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
        ],
    }
    topics = {"front": [STANDING, RUN_TOPIC, f"✔ {EARLIER_TOPIC}"],
              "pj-ghtrends": ["workplan-trend8", "✔ workplan-trend7"]}
    histories.update(kwargs.pop("histories", {}))
    topics.update(kwargs.pop("topics", {}))
    return chain_realm(histories=histories, topics=topics, **kwargs)


def test_a_routine_run_closes_that_run_and_its_work_only():
    found = discover({}, ("front", RUN_TOPIC), realm=routine_realm(), plane=board())
    assert found.scope.kind == ROUTINE_RUN and found.scope.closable
    assert found.scope.routine == {"name": ROUTINE, "stamp": STAMP, "standing_topic": STANDING,
                                   "previous_run": EARLIER_TOPIC}
    assert topic_keys(found) == [
        ("front", RUN_TOPIC), ("pj-ghtrends", "workplan-trend8"),
        ("work-g-17", "workrun-task1-g-17"),
        ("agforge-agstudio1", "assetplan-robot"), ("agforge-agstudio1", "assetrun-robot"),
    ]
    # The standing request and the previous run are named as context —
    # untouched, and said so — never reached, never targets.
    assert [(row["topic"], row["relation"]) for row in found.scope.context] == [
        (STANDING, "standing request"), (EARLIER_TOPIC, "previous run")]
    assert "earlier runs are not touched" in found.scope.description
    assert all(row["topic"] not in {STANDING, EARLIER_TOPIC, "workplan-trend7"}
               for row in found.excluded)
    keys = {action.key for action in plan_actions(found)}
    assert f"topic:front/{STANDING}" not in keys and f"topic:front/{EARLIER_TOPIC}" not in keys
    assert f"topic:front/{RUN_TOPIC}" in keys and "topic:pj-ghtrends/workplan-trend7" not in keys


def test_a_previous_run_reached_by_a_link_is_still_another_request():
    """Even when a note *does* name the earlier run — say Front served a
    late callback from it — it is another run, and its work is its own."""
    realm = routine_realm(histories={
        ("front", RUN_TOPIC): [
            post(200, fire_line(ROUTINE, STAMP, previous=EARLIER_TOPIC),
                 sender_id=DEVELOPER, sender="Developer"),
            selfnote(201, "served", "pj-ghtrends/workplan-trend8 1"),
            selfnote(203, "served", f"front/{EARLIER_TOPIC} 152"),
            selfnote(204, "served", f"front/{STANDING} 100"),
        ],
    })
    found = discover({}, ("front", RUN_TOPIC), realm=realm, plane=board())
    assert excluded_of(found, EARLIER_TOPIC)["reason"] == (
        f"another request: a run of routine {ROUTINE}")
    assert excluded_of(found, STANDING)["reason"] == (
        f"the standing request of routine {ROUTINE}: a ✔ there means something else")
    assert "workplan-trend7" not in {node.topic for node in found.topics}
    assert {work.label for work in found.works} == {"G-17", "G-18", "F2-28"}


def test_the_standing_request_is_never_a_root():
    found = discover({}, ("front", STANDING), realm=routine_realm(), plane=board())
    assert found.scope.closable is False and "retires the routine" in found.scope.reason
    assert found.works == [] and found.channels == []
    [action] = plan_actions(found)
    assert action.state == BLOCKED and action.reason == found.scope.reason


def test_an_introduction_is_never_a_root():
    realm = Realm({("agents", "intro-agforge-agstudio1"): [post(1, "hello", sender_id=FORGE_BOT)]},
                  streams={"agents": 3})
    found = discover({}, ("agents", "intro-agforge-agstudio1"), realm=realm, plane=board())
    assert found.scope.kind == INTRO and found.scope.closable is False
    assert "retires the agent" in found.scope.reason


def test_an_autolab_request_is_a_root_and_its_front_parent_stays_open():
    """`pj-ghtrends/workplan-trend8` was opened for the desk conversation;
    completing it from the agent room closes the plan, its task, its Work
    and its channel — and names the desk as where it came from."""
    found = discover({}, ("pj-ghtrends", "workplan-trend8"), realm=chain_realm(), plane=board())
    assert found.scope.kind == WORKPLAN and found.scope.closable
    assert [(p["channel"], p["topic"], p["kind"]) for p in found.scope.parents] == [
        ("front", DESK_TOPIC, DESK)]
    assert found.scope.parents[0]["message_id"] == 10
    assert "which stays open" in found.scope.description
    assert topic_keys(found) == [
        ("pj-ghtrends", "workplan-trend8"), ("work-g-17", "workrun-task1-g-17"),
        ("agforge-agstudio1", "assetplan-robot"), ("agforge-agstudio1", "assetrun-robot"),
    ]
    assert ("front", DESK_TOPIC) not in topic_keys(found)
    assert all(row["topic"] != DESK_TOPIC for row in found.excluded)
    mission = next(work for work in found.works if work.label == "G-17")
    assert mission.role == "mission" and mission.evidence[0]["how"] == "external_id"
    assert [row["channel"] for row in found.channels if row["archivable"]] == ["work-g-17"]
    actions = plan_actions(found)
    assert actions[-1].key == "topic:pj-ghtrends/workplan-trend8" and actions[-1].state == READY


def test_a_forge_request_is_a_root_with_its_run_beside_it():
    found = discover({}, ("agforge-agstudio1", "assetplan-robot"),
                     realm=chain_realm(), plane=board())
    assert found.scope.kind == ASSETPLAN and found.scope.closable
    assert [(p["topic"], p["kind"]) for p in found.scope.parents] == [
        ("workrun-task1-g-17", WORKRUN)]
    assert topic_keys(found) == [
        ("agforge-agstudio1", "assetplan-robot"), ("agforge-agstudio1", "assetrun-robot")]
    assert [work.label for work in found.works] == ["F2-28"]
    assert found.channels == []


# --- an execution topic names its parent ---------------------------------------------


def test_a_task_topic_offers_its_parent_and_closes_nothing():
    found = discover({}, ("work-g-17", "workrun-task1-g-17"), realm=chain_realm(), plane=board())
    assert found.scope.kind == WORKRUN and found.scope.closable is False
    assert [(p["channel"], p["topic"], p["kind"], p["message_id"]) for p in found.scope.parents] == [
        ("pj-ghtrends", "workplan-trend8", WORKPLAN, 20)]
    assert "select that request" in found.scope.reason
    assert found.works == [] and found.channels == []
    # What the walk reached beyond it is the parent's, and said so.
    assert {row["reason"] for row in found.excluded} == {"belongs to the parent request"}
    [action] = plan_actions(found)
    assert action.kind == "conversation" and action.state == BLOCKED
    assert action.detail["parents"] == found.scope.parents


def test_a_forge_run_topic_offers_its_plan():
    found = discover({}, ("agforge-agstudio1", "assetrun-robot"), realm=chain_realm(), plane=board())
    assert found.scope.closable is False
    assert [p["topic"] for p in found.scope.parents] == ["assetplan-robot"]


def test_an_unknown_topic_with_a_root_note_is_somebody_s_child():
    realm = chain_realm(histories={
        ("agautolab-agstudio1", "probe-1"): [
            selfnote(70, "rootchat", f"front/{DESK_TOPIC}"),
            post(71, "probing", sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
        ],
    }, topics={"agautolab-agstudio1": ["probe-1"]}, )
    realm.streams["agautolab-agstudio1"] = 40
    found = discover({}, ("agautolab-agstudio1", "probe-1"), realm=realm, plane=board())
    assert found.scope.kind == TOPIC and found.scope.closable is False
    assert [p["topic"] for p in found.scope.parents] == [DESK_TOPIC]


def test_an_unknown_topic_without_a_root_note_is_its_own_request():
    realm = Realm({("agautolab-agstudio1", "how is the board"): [
        post(1, "how is the board?", sender_id=DEVELOPER, sender="Developer"),
        post(2, "three plans open.", sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
    ]}, streams={"agautolab-agstudio1": 40}, topics={"agautolab-agstudio1": ["how is the board"]})
    found = discover({}, ("agautolab-agstudio1", "how is the board"), realm=realm, plane=board())
    assert found.scope.kind == TOPIC and found.scope.closable
    [action] = plan_actions(found)
    assert action.kind == "conversation" and action.state == READY


def test_closing_the_selected_request_never_touches_its_parent(tmp_path):
    door, realm, plane = closer(realm=WritingRealm(open_chain()))
    found = door.close(("pj-ghtrends", "workplan-trend8"))
    assert found["applied"] is True and found["partial"] is False
    assert [topic for _, topic in realm.resolved] == [
        "assetplan-robot", "assetrun-robot", "workplan-trend8"]
    assert DESK_TOPIC not in [topic for _, topic in realm.resolved]
    assert plane.completed == [(GHTRENDS, MISSION)]


# --- ownership, generalised ----------------------------------------------------------


def test_a_plan_anchored_to_another_front_conversation_is_not_this_one_s():
    """The reused plan topic, met from the desk — and the other owner is an
    ordinary `front-*` conversation now, not another desk."""
    realm = chain_realm(histories={
        ("pj-ghtrends", "workplan-trend8"): [
            selfnote(9, "rootchat", f"front/{FRONT_TOPIC}"),
            selfnote(10, "rootchat", f"front/{DESK_TOPIC}"),
            selfnote(12, "served", "work-g-17/workrun-task1-g-17 1"),
        ],
    })
    found = discover({}, ROOT, realm=realm, plane=board())
    shared = excluded_of(found, "workplan-trend8")
    assert shared["reason"] == f"anchored to another request (front/{FRONT_TOPIC})"
    assert [row["message_id"] for row in shared["evidence"]] == [9]
    assert shared["kind"] == WORKPLAN
    assert topic_keys(found) == [ROOT]
    assert found.works == []


def test_another_request_of_every_kind_is_outside_the_closure():
    """Each request kind, reached from the desk by a served note with no root
    note of its own naming us, is excluded as *another request*."""
    others = {
        ("front", FRONT_TOPIC): "a Front conversation",
        ("front", RUN_TOPIC): f"a run of routine {ROUTINE}",
        ("pj-ghtrends", "workplan-other"): "an Autolab request",
        ("agforge-agstudio1", "assetplan-other"): "a Forge request",
    }
    histories = {("front", DESK_TOPIC): [
        post(1, "hello", sender_id=DEVELOPER, sender="Developer"),
        *[selfnote(2 + i, "served", f"{ch}/{tp} 1") for i, (ch, tp) in enumerate(others)],
    ]}
    for channel, topic in others:
        histories[(channel, topic)] = [post(50, "somebody's conversation")]
    realm = chain_realm(histories=histories, topics={
        "pj-ghtrends": ["workplan-trend8", "workplan-other"],
        "agforge-agstudio1": ["✔ assetplan-robot", "✔ assetrun-robot", "assetplan-other"],
    })
    found = discover({}, ROOT, realm=realm, plane=board())
    assert topic_keys(found) == [ROOT]
    for (channel, topic), what in others.items():
        assert excluded_of(found, topic)["reason"] == f"another request: {what}"


def test_nested_delegation_is_owned_to_the_bottom_from_a_routine_run():
    """run → workplan → workrun → assetplan → assetrun: every level carries a
    root note naming the level above, and the walk owns all of it."""
    found = discover({}, ("front", RUN_TOPIC), realm=routine_realm(), plane=board())
    depths = {node.topic: node.depth for node in found.topics}
    assert depths == {RUN_TOPIC: 0, "workplan-trend8": 1, "workrun-task1-g-17": 2,
                      "assetplan-robot": 3, "assetrun-robot": 4}
    assert found.excluded == []


def test_a_resolved_intermediate_is_walked_through():
    realm = chain_realm(histories={
        ("pj-ghtrends", "✔ workplan-trend8"): [
            selfnote(10, "rootchat", f"front/{DESK_TOPIC}"),
            post(11, "Planned as G-17.", sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
        ],
    }, topics={"pj-ghtrends": ["✔ workplan-trend8"]})
    realm.histories.pop(("pj-ghtrends", "workplan-trend8"))
    found = discover({}, ROOT, realm=realm, plane=board())
    plan = next(node for node in found.topics if node.topic == "workplan-trend8")
    assert plan.resolved is True
    assert ("work-g-17", "workrun-task1-g-17") in topic_keys(found)
    assert {work.label for work in found.works} >= {"G-17", "G-18"}


def test_a_task_nothing_links_is_not_this_request_s():
    """Missing relationship evidence: a second task topic in the mission's
    channel with no root note and nothing naming it is neither a target nor
    silently swept in — and it keeps the channel."""
    realm = chain_realm(topics={"work-g-17": ["✔ workrun-task1-g-17", "workrun-task2-g-17"]})
    realm.histories[("work-g-17", "workrun-task2-g-17")] = [
        post(60, "a task with no anchor", sender_id=AUTOLAB_BOT, sender="autolab-agstudio1")]
    found = discover({}, ROOT, realm=realm, plane=board())
    assert ("work-g-17", "workrun-task2-g-17") not in topic_keys(found)
    row = next(one for one in found.channels if one["channel"] == "work-g-17")
    assert row["archivable"] is False and row["unaccounted"] == ["workrun-task2-g-17"]


def test_a_topic_anchored_to_an_owned_request_is_owned_whatever_reached_it():
    """A forge plan anchored to our task is ours even when the only link that
    reached it came through a topic we do not own."""
    realm = chain_realm(histories={
        ("front", DESK_TOPIC): [
            post(1, "hello", sender_id=DEVELOPER, sender="Developer"),
            selfnote(2, "served", "pj-ghtrends/workplan-trend8 1"),
            selfnote(3, "served", f"front/{FRONT_TOPIC} 1"),
        ],
        ("front", FRONT_TOPIC): [
            post(5, "another conversation", sender_id=DEVELOPER, sender="Developer"),
            selfnote(6, "served", "agforge-agstudio1/assetplan-robot 1"),
        ],
        ("work-g-17", "✔ workrun-task1-g-17"): [
            selfnote(20, "rootchat", "pj-ghtrends/workplan-trend8",
                     sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
            selfnote(21, "work", TASK, sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
        ],
    })
    found = discover({}, ROOT, realm=realm, plane=board())
    assert excluded_of(found, FRONT_TOPIC)["reason"] == "another request: a Front conversation"
    assert ("agforge-agstudio1", "assetplan-robot") in topic_keys(found)


# --- the door and its routes ------------------------------------------------------------


def test_a_key_is_read_bare_and_refused_when_malformed():
    assert parse_key("pj-x", "✔ workplan-y") == ("pj-x", "workplan-y")
    assert parse_key(" front ", " front-desk-1 ") == ("front", "front-desk-1")
    assert "strings" in parse_key(None, "x")["error"]
    assert "named" in parse_key("front", "")["error"]
    assert "one line" in parse_key("front", "a\nb")["error"]
    assert "at most" in parse_key("front", "x" * 201)["error"]


def test_the_door_takes_a_key_and_the_front_desk_id_is_one_caller():
    door, _, _ = closer()
    by_key = door.plan(ROOT)
    by_id = door.plan(Closer.desk_key("20260908-1600"))
    assert by_key["fingerprint"] == by_id["fingerprint"]
    assert by_key["scope"]["kind"] == DESK and by_key["root"] == {"channel": "front", "topic": DESK_TOPIC}
    assert door.plan(Closer.desk_key("../etc"))["error"].endswith("is not a Front Desk conversation id")
    assert door.plan(parse_key("front", ""))["error"] == "channel and topic must both be named"


def test_a_history_of_operations_is_kept_per_request():
    door, _, _ = closer(realm=WritingRealm(open_chain()))
    assert door.plan(ROOT)["history"] == []
    door.close(ROOT)
    door.close(("pj-ghtrends", "workplan-trend8"))
    [record] = door.records(ROOT)
    assert record["kind"] == DESK and record["topic"] == DESK_TOPIC
    assert len(door.records()) == 2
    assert door.plan(ROOT)["history"] == [record]


@pytest.fixture()
def relay():
    door, realm, plane = closer(realm=WritingRealm(open_chain()))
    server = build_server("127.0.0.1", 0, Room(env_path=__file__), closer=door)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server.server_address[1], door, realm, plane
    server.shutdown()
    server.server_close()


def request(port, method, path, body=None):
    connection = HTTPConnection("127.0.0.1", port, timeout=5)
    payload = None if body is None else json.dumps(body)
    connection.request(method, path, payload, {"Content-Type": "application/json"})
    response = connection.getresponse()
    found = json.loads(response.read())
    connection.close()
    return response.status, found


def test_the_shared_routes_take_a_channel_and_a_topic(relay):
    port, _, realm, plane = relay
    status, found = request(port, "GET", "/complete/plan?channel=pj-ghtrends&topic=workplan-trend8")
    assert status == 200 and found["scope"]["kind"] == WORKPLAN
    assert plane.completed == [] and realm.resolved == []
    status, applied = request(port, "POST", "/complete", {
        "channel": "pj-ghtrends", "topic": "workplan-trend8", "fingerprint": found["fingerprint"]})
    assert status == 200 and applied["applied"] is True
    assert plane.completed == [(GHTRENDS, MISSION)]
    assert DESK_TOPIC not in [topic for _, topic in realm.resolved]
    status, history = request(port, "GET", "/complete/history?channel=pj-ghtrends&topic=workplan-trend8")
    assert status == 200 and len(history["history"]) == 1
    status, everything = request(port, "GET", "/complete/history")
    assert status == 200 and len(everything["history"]) == 1


def test_a_malformed_key_is_400_and_a_stale_approval_409(relay):
    port, _, realm, plane = relay
    assert request(port, "GET", "/complete/plan?channel=front")[0] == 400
    assert request(port, "POST", "/complete", {"topic": "x"})[0] == 400
    status, found = request(port, "POST", "/complete", {
        "channel": "front", "topic": DESK_TOPIC, "fingerprint": "0000000000000000"})
    assert status == 409 and found["refused"] is True
    assert plane.completed == [] and realm.resolved == []


def test_an_execution_topic_over_http_is_a_plan_with_nothing_to_approve(relay):
    port, _, realm, plane = relay
    status, found = request(port, "GET", "/complete/plan?channel=work-g-17&topic=workrun-task1-g-17")
    assert status == 200 and found["scope"]["closable"] is False
    assert found["counts"] == {"ready": 0, "blocked": 1, "done": 0, "kept": 0}
    assert [p["topic"] for p in found["scope"]["parents"]] == ["workplan-trend8"]
    status, applied = request(port, "POST", "/complete", {
        "channel": "work-g-17", "topic": "workrun-task1-g-17", "fingerprint": found["fingerprint"]})
    assert status == 200 and applied["partial"] is True
    assert plane.completed == [] and realm.resolved == [] and realm.archived == []


# --- a task re-run for a later routine run (the live shape) --------------------------


LATER = "2026-09-09T02:00Z"
LATER_TOPIC = run_topic(ROUTINE, LATER)


def rerun_realm():
    """`workplan-trend8` was planned for run STAMP; run LATER asked for the
    task to be re-run. The re-run topic carries autolab's root note naming
    the plan and Front's root note naming the later run, and the later run's
    served note names the re-run topic — exactly what the realm held on
    2026-09-08 for `work-s4-5/workrun-rerun-task1-s4-5`."""
    return routine_realm(histories={
        ("front", LATER_TOPIC): [
            post(300, fire_line(ROUTINE, LATER, previous=RUN_TOPIC),
                 sender_id=DEVELOPER, sender="Developer"),
            selfnote(301, "served", "work-g-17/workrun-rerun-task1-g-17 1"),
            post(302, "Re-ran the task."),
        ],
        ("work-g-17", "workrun-rerun-task1-g-17"): [
            selfnote(80, "rootchat", "pj-ghtrends/workplan-trend8",
                     sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
            selfnote(81, "work", TASK, sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
            selfnote(82, "rootchat", f"front/{LATER_TOPIC}"),
            post(83, "re-run done", sender_id=AUTOLAB_BOT, sender="autolab-agstudio1"),
        ],
    }, topics={"front": [STANDING, RUN_TOPIC, LATER_TOPIC, f"✔ {EARLIER_TOPIC}"],
               "work-g-17": ["✔ workrun-task1-g-17", "workrun-rerun-task1-g-17"]})


def test_a_task_rerun_for_a_later_run_belongs_to_its_plan_s_run():
    """From the run that planned it: the re-run is owned by autolab's note,
    and Front's later visit is shown as a visitor, not obeyed."""
    found = discover({}, ("front", RUN_TOPIC), realm=rerun_realm(), plane=board())
    rerun = next(node for node in found.topics if node.topic == "workrun-rerun-task1-g-17")
    assert [v["topic"] for v in rerun.visitors] == [LATER_TOPIC]
    assert rerun.visitors[0]["message_id"] == 82
    row = next(one for one in found.channels if one["channel"] == "work-g-17")
    assert row["archivable"] is True and row["unaccounted"] == []
    assert found.excluded == []


def test_the_later_run_does_not_own_the_task_it_had_re_run():
    found = discover({}, ("front", LATER_TOPIC), realm=rerun_realm(), plane=board())
    assert topic_keys(found) == [("front", LATER_TOPIC)]
    row = excluded_of(found, "workrun-rerun-task1-g-17")
    assert row["reason"] == "anchored to another request (pj-ghtrends/workplan-trend8)"
    assert [e["message_id"] for e in row["evidence"]] == [80]
    assert found.works == [] and found.channels == []
    assert [c["topic"] for c in found.scope.context if c["relation"] == "previous run"] == [RUN_TOPIC]


def test_the_plan_owns_its_re_run_task_and_names_the_visit():
    found = discover({}, ("pj-ghtrends", "workplan-trend8"), realm=rerun_realm(), plane=board())
    names = {node.topic for node in found.topics}
    assert {"workrun-task1-g-17", "workrun-rerun-task1-g-17"} <= names
    rerun = next(node for node in found.topics if node.topic == "workrun-rerun-task1-g-17")
    assert [v["topic"] for v in rerun.visitors] == [LATER_TOPIC]
    assert [p["topic"] for p in found.scope.parents] == [RUN_TOPIC]


def test_a_re_run_topic_names_its_plan_first_and_the_visit_second():
    found = discover({}, ("work-g-17", "workrun-rerun-task1-g-17"), realm=rerun_realm(), plane=board())
    assert [(p["topic"], p["structural"]) for p in found.scope.parents] == [
        ("workplan-trend8", True), (LATER_TOPIC, False)]
    assert found.scope.reason.startswith("this is an Autolab task topic of #pj-ghtrends › workplan-trend8;")
    assert f"also served on behalf of #front › {LATER_TOPIC}" in found.scope.reason


def test_a_plan_the_walk_never_named_is_read_upward_and_joins_by_its_own_note():
    """Front served a task but never the plan: the plan is reached only by
    reading the task's home, and it joins because *its* note names the run."""
    realm = routine_realm(histories={
        ("front", RUN_TOPIC): [
            post(200, fire_line(ROUTINE, STAMP), sender_id=DEVELOPER, sender="Developer"),
            selfnote(201, "served", "work-g-17/workrun-task1-g-17 1"),
        ],
    })
    found = discover({}, ("front", RUN_TOPIC), realm=realm, plane=board())
    plan = next(node for node in found.topics if node.topic == "workplan-trend8")
    assert plan.depth == 1 and [l["via"] for l in plan.links] == ["rootchat"]
    assert ("work-g-17", "workrun-task1-g-17") in topic_keys(found)
    assert {work.label for work in found.works} >= {"G-17", "G-18"}


def test_a_topic_in_an_archived_channel_is_kept_and_the_request_still_closes():
    """Met live: `front-p2-greet-agecho` reached `#agecho-agstudio1 › hello`,
    readable, unresolved — and the channel is archived, so the resolve was a
    400 and the conversation stayed open. Now it is kept, said so, and the
    request closes over it."""
    realm = Realm({
        ("front", FRONT_TOPIC): [
            post(1, "say hello to agecho", sender_id=DEVELOPER, sender="Developer"),
            selfnote(2, "served", "agecho-agstudio1/hello 9"),
            post(3, "it said hello back"),
        ],
        ("agecho-agstudio1", "hello"): [
            selfnote(8, "rootchat", f"front/{FRONT_TOPIC}"),
            post(9, "hello", sender_id=99, sender="agecho"),
        ],
    }, topics={"front": [FRONT_TOPIC]}, streams={"front": 24})
    door, _, _ = closer(realm=WritingRealm(realm), plane=writing_board())
    found = door.plan(("front", FRONT_TOPIC))
    by_key = {a["key"]: a for a in found["actions"]}
    hello = by_key["topic:agecho-agstudio1/hello"]
    assert hello["state"] == "kept" and "is archived" in hello["reason"]
    assert by_key[f"topic:front/{FRONT_TOPIC}"]["state"] == READY
    applied = door.close(("front", FRONT_TOPIC), found["fingerprint"])
    assert applied["partial"] is False
    outcomes = {row["key"]: row["outcome"] for row in applied["results"]}
    assert outcomes["topic:agecho-agstudio1/hello"] == "skipped"
    assert outcomes[f"topic:front/{FRONT_TOPIC}"] == "applied"
