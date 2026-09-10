"""forge's work record as this room reads it (`refactor` p2 step 4).

The companion of the autolab half in `test_scope.py`. What is pinned is the
format (`agforge.anchor`'s, reproduced without importing agforge), the two
reading rules — identity written once, state newest-wins — and **forge's own
lifecycle**, which is not autolab's counting rule.
"""

import pytest

from agentroom.forge import (
    ALREADY_ACCEPTED, Request, Run, notes_in, read_record, reason_not_accepted,
)

FORGE_BOT, DEVELOPER, OTHER_BOT = 9, 8, 15
CHANNEL, TOPIC = "agforge-agstudio1", "assetplan-robot"


def post(ident, content, sender_id=FORGE_BOT, sender="forge"):
    return {"id": ident, "sender_id": sender_id, "sender_full_name": sender,
            "content": content}


def note(ident, tag, value, **kwargs):
    return post(ident, f"[selfnote][{tag}] {value}", **kwargs)


def request_history(*extra):
    return [note(31, "asset", "robot"), post(32, "# Render a robot\n\nOne PNG."),
            note(33, "doc", "32"), note(34, "tools", "toolset-image"), *extra]


def read(messages, channel=CHANNEL, topic=TOPIC):
    return read_record(channel, topic, notes_in(messages))


# --- what a conversation is -------------------------------------------------


def test_an_asset_note_makes_a_conversation_a_request():
    found = read(request_history(note(35, "state", "delivered")))
    assert isinstance(found, Request)
    assert found.anchor_id == 31 and found.label == "a31" and found.stem == "robot"
    assert found.document_id == 32 and found.tools == ["toolset-image"]
    assert found.state == "delivered"


def test_an_assetrun_note_makes_a_conversation_a_run():
    found = read([note(41, "assetrun", "31"), note(42, "state", "pending")],
                 topic="assetrun-robot-a31")
    assert isinstance(found, Run)
    assert (found.anchor_id, found.request_id, found.label) == (41, 31, "r41")
    assert found.pending is True


def test_a_conversation_that_is_neither_is_neither():
    assert read([post(1, "hello"), note(2, "rootchat", "front/front-desk-1")]) is None


def test_identity_is_written_once_so_the_earliest_note_wins():
    found = read([note(31, "asset", "robot"), note(90, "asset", "robot-again")])
    assert found.anchor_id == 31 and found.stem == "robot"


def test_state_and_plan_are_newest_wins():
    found = read(request_history(
        note(35, "state", "failed"), post(36, "# Render a robot\n\nTwo PNGs."),
        note(37, "doc", "36"), note(38, "state", "delivered")))
    assert found.state == "delivered" and found.document_id == 36


def test_only_the_record_s_own_author_says_where_its_work_has_got_to():
    """A visitor's `[state]` line must not move somebody else's record."""
    found = read(request_history(
        note(35, "state", "delivered"),
        note(36, "state", "failed", sender_id=OTHER_BOT, sender="Front")))
    assert found.state == "delivered"


def test_acceptance_is_read_from_anybody():
    """The one word somebody else may write — `refactor` p1 step 4's defect,
    which was invisible to the record it was written into."""
    found = read(request_history(
        note(35, "state", "delivered"),
        note(36, "state", "accepted", sender_id=DEVELOPER, sender="Developer")))
    assert found.state == "accepted"


def test_a_recorded_selection_of_none_is_not_no_selection():
    assert read([note(31, "asset", "robot"), note(34, "tools", "-")]).tools == []
    assert read([note(31, "asset", "robot")]).tools is None


def test_results_are_the_durable_keys_in_order_without_repeats():
    found = read(request_history(
        note(35, "result", "files/one.zip"), note(36, "result", "files/two.zip"),
        note(37, "result", "files/one.zip")))
    assert found.results == ["files/one.zip", "files/two.zip"]


# --- forge's lifecycle ------------------------------------------------------


def request(state="delivered", **kwargs):
    return Request(anchor_id=31, stem="robot", channel=CHANNEL, topic=TOPIC,
                   state=state, **kwargs)


def run(state="delivered"):
    return Run(anchor_id=41, request_id=31, channel=CHANNEL,
               topic="assetrun-robot-a31", state=state)


def test_a_delivered_request_may_be_accepted():
    assert reason_not_accepted(request(), [run()]) is None


def test_a_request_needs_no_run_of_its_own_to_be_finished():
    """Not autolab's rule: what finishes a request is that something was
    delivered, not that every run of it completed."""
    assert reason_not_accepted(request(), []) is None


def test_one_failed_run_beside_a_delivered_request_does_not_block_it():
    """A second attempt after a failure is the same request trying again,
    and the newest state on the request is its verdict."""
    assert reason_not_accepted(request(), [run("failed"), run()]) is None


def test_nothing_delivered_yet_blocks():
    assert reason_not_accepted(request("planned"), []) == "nothing has been delivered yet"


def test_a_failed_request_says_what_to_do_about_it():
    assert reason_not_accepted(request("failed"), [run("failed")]) == (
        "its last attempt failed; run it again or retire it")


def test_a_pending_generation_blocks_and_names_the_run():
    reason = reason_not_accepted(request("planned"), [run("pending")])
    assert reason == ("a generation is still running (r41), so nothing has been "
                      "delivered yet")


def test_a_pending_generation_blocks_even_a_delivered_request():
    """A request delivered once and generating again is not finished: the
    outstanding job is what keeps its conversations reachable."""
    assert "still running" in reason_not_accepted(request(), [run("pending")])


def test_an_accepted_request_is_a_no_op():
    assert reason_not_accepted(request("accepted"), [run()]) == ALREADY_ACCEPTED


def test_a_retired_request_is_another_request():
    assert reason_not_accepted(request("retired"), [run()]) == (
        "it was retired, and its replacement is the request to finish")
