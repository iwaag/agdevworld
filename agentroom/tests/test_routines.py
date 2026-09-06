"""The routine board's rules, against made-up routines.

The live realm cannot prove any of these either: every routine on it is
answered most of the time, and the states worth getting right are the ones
that mean somebody has to look.
"""

import json

from agentroom.ops import Topic
from agentroom.routines import (
    Schedule,
    answer_of,
    fire_of,
    is_routine_topic,
    read_schedule,
    routine_name,
    routine_rows,
    schedule_for,
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
    assert found.served == {("pj-studyarxiv", "workplan-papers"): 2809}


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
