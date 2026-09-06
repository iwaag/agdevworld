"""The state engine's rules, against made-up conversations.

Every test here is a p1 finding that cost something to learn. The live realm
cannot prove any of them: it is quiet most of the time, and a broken route
reads exactly like a board with nothing on it.
"""

from agag.intro import Roster

from agentroom.ops import Ops, Topic, acked, describe, named_in, owns, row_state

NOW = 1_800_000_000.0
FORGE = Roster(
    instance="agforge-agstudio1",
    agent="agforge",
    bot="agforge-agstudio1",
    bot_id=13,
    channel="agforge-agstudio1",
    prefixes=("assetplan-", "assetrun-"),
)
FRONT = Roster(
    instance="front-agstudio1",
    agent="front",
    bot="Front",
    bot_id=15,
    channel="front-agstudio1",
    prefixes=("front-",),
)
STALL = 900.0


def message(content, *, ident=1, sender_id=8, sender="Developer", ago=0.0, system=False):
    return {
        "id": ident,
        "sender_id": sender_id,
        "sender_full_name": sender,
        "sender_realm_str": "zulipinternal" if system else "agdev",
        "timestamp": int(NOW - ago),
        "content": content,
    }


def topic(channel, name, *messages, resolved=False):
    found = Topic(channel=channel, topic=name, live_topic=name, resolved=resolved)
    for one in messages:
        found.add(one)
    return found


def state(found, roster=FORGE, mark=0, now=NOW):
    row = row_state(found, roster, mark, now, STALL)
    return row["state"] if row else None


# --- the roster is the routing --------------------------------------------


def test_the_owner_route_is_the_channel_by_name_or_a_prefix_anywhere():
    assert owns(FORGE, "agforge-agstudio1", "anything at all")
    assert owns(FORGE, "pj-mediagen", "assetplan-a-poster")
    assert not owns(FORGE, "pj-mediagen", "workplan-something")


def test_front_owns_no_channel_and_is_served_by_its_prefix_alone():
    # p1's worst single mistake was assuming Front owns `#front`: seven
    # phantom stalls, every one a standing `routine-` definition nobody was
    # waiting on. The roster states `front-agstudio1`, which is not a channel.
    assert not owns(FRONT, "front", "routine-imgprompt")
    assert owns(FRONT, "front", "front-a-request")


# --- awaiting, and the two routes -----------------------------------------


def test_an_owner_owes_a_reply_when_somebody_else_spoke_last():
    found = topic("agforge-agstudio1", "assetplan-poster", message("please make a poster"))
    assert state(found) == "awaiting"


def test_an_owner_owes_nothing_once_it_has_answered():
    found = topic(
        "agforge-agstudio1", "assetplan-poster",
        message("please", ident=1),
        message("here it is", ident=2, sender_id=13, sender="agforge-agstudio1"),
    )
    assert state(found) is None


def test_a_selfnote_is_never_somebody_speaking():
    # The invariant the whole system rests on: a note one agent writes in
    # another's topic must not buy that agent a run — nor, here, a row.
    found = topic(
        "agforge-agstudio1", "assetplan-poster",
        message("please", ident=1),
        message("done", ident=2, sender_id=13, sender="agforge-agstudio1"),
        message("[selfnote][rootchat] front/front-9", ident=3, sender_id=15, sender="Front"),
    )
    assert state(found) is None


def test_zulips_own_notices_are_not_somebody_speaking():
    found = topic(
        "agforge-agstudio1", "assetplan-poster",
        message("please", ident=1),
        message("done", ident=2, sender_id=13, sender="agforge-agstudio1"),
        message("marked this topic as resolved.", ident=3, sender="Notification Bot", system=True),
    )
    assert state(found) is None


def test_a_mention_in_a_topic_the_agent_does_not_own_is_the_other_route():
    found = topic("pj-mediagen", "workrun-task2", message("@**Front** what next?"))
    assert state(found, FRONT) == "awaiting"


def test_a_served_note_covering_the_mention_closes_it():
    # The answer went home, so this agent never becomes the last poster here.
    # Without the mark, "somebody spoke and named me" stays true forever and
    # every restart re-serves every exchange the agent ever had.
    found = topic("pj-mediagen", "workrun-task2", message("@**Front** what next?", ident=77))
    assert state(found, FRONT, mark=77) is None
    assert state(found, FRONT, mark=76) == "awaiting"


def test_served_note_differencing_is_never_applied_to_an_owned_topic():
    # p1's five-day phantom: an owner answers *in place* and writes no served
    # note, so differencing over its own topics reports every answered call as
    # pending forever. The routes are exclusive.
    found = topic(
        "agforge-agstudio1", "assetplan-poster",
        message("@**agforge-agstudio1** please", ident=1),
        message("here it is", ident=2, sender_id=13, sender="agforge-agstudio1"),
    )
    assert state(found) is None


def test_the_mention_clock_starts_at_the_oldest_unanswered_call():
    # A second nudge must not make an old stall look fresh.
    found = topic(
        "pj-mediagen", "workrun-task2",
        message("@**Front** ping", ident=1, ago=3600),
        message("@**Front** still there?", ident=2, ago=60),
    )
    assert named_in(found, FRONT, 0).id == 1
    assert state(found, FRONT) == "stalled"


def test_an_agent_naming_itself_does_not_owe_itself_a_reply():
    found = topic("pj-mediagen", "workrun-task2",
                  message("@**Front** see above", ident=1, sender_id=15, sender="Front"))
    assert state(found, FRONT) is None


# --- stalled ---------------------------------------------------------------


def test_stalled_is_awaiting_plus_age_and_the_threshold_is_a_setting():
    found = topic("agforge-agstudio1", "assetplan-poster", message("please", ago=1000))
    assert state(found) == "stalled"
    assert row_state(found, FORGE, 0, NOW, 2000.0)["state"] == "awaiting"


# --- acked ----------------------------------------------------------------


def test_the_agents_own_ack_is_running_as_chat_can_see_it():
    found = topic(
        "agforge-agstudio1", "assetplan-poster",
        message("please", ident=1),
        message("Message received. Please wait for the reply.",
                ident=2, sender_id=13, sender="agforge-agstudio1"),
    )
    assert acked(found, FORGE)
    assert state(found) is None  # not owed; the acked pass owns this row


def test_somebody_elses_ack_shaped_post_is_still_somebody_speaking():
    found = topic(
        "agforge-agstudio1", "assetplan-poster",
        message("Message received. Please wait for the reply.", ident=1, sender="Developer"),
    )
    assert not acked(found, FORGE)
    assert state(found) == "awaiting"


# --- done, and the ✔ rename ------------------------------------------------


def test_done_is_zulips_resolve_marker_and_nothing_else():
    found = topic("agforge-agstudio1", "assetplan-poster",
                  message("please"), resolved=True)
    assert state(found) == "done"


def test_a_resolved_topic_this_agent_was_never_party_to_is_not_its_row():
    found = topic("pj-mediagen", "workplan-x", message("please"), resolved=True)
    assert state(found, FORGE) is None


def test_a_rename_flips_the_row_it_does_not_open_a_second_one():
    # Bare-topic keying, which is the p9 lesson: 36% of Front's served notes
    # and 90% of autolab's name a topic that today exists only under its ✔
    # name, and matching verbatim turns each into a call never answered.
    ops = Ops(env_path=__file__)  # never connected; only the event path is used
    ops._stream_names = {7: "agforge-agstudio1"}
    ops._topics = {("agforge-agstudio1", "assetplan-poster"):
                   topic("agforge-agstudio1", "assetplan-poster", message("please"))}
    ops._apply({"type": "update_message", "stream_id": 7,
                "orig_subject": "assetplan-poster", "subject": "✔ assetplan-poster"})
    assert list(ops._topics) == [("agforge-agstudio1", "assetplan-poster")]
    only = ops._topics[("agforge-agstudio1", "assetplan-poster")]
    assert only.resolved and only.live_topic == "✔ assetplan-poster"


def test_a_real_rename_moves_the_row_rather_than_duplicating_it():
    ops = Ops(env_path=__file__)
    ops._stream_names = {7: "agforge-agstudio1"}
    ops._topics = {("agforge-agstudio1", "old-name"):
                   topic("agforge-agstudio1", "old-name", message("please"))}
    ops._apply({"type": "update_message", "stream_id": 7,
                "orig_subject": "old-name", "subject": "new-name"})
    assert list(ops._topics) == [("agforge-agstudio1", "new-name")]


# --- the roster is not guessed --------------------------------------------


def ops_with(rosters, topics=(), live=True, retired=()):
    ops = Ops(env_path=__file__, stalled_seconds=STALL)
    ops._rosters = rosters
    ops._retired = set(retired)
    ops._topics = {(t.channel, t.topic): t for t in topics}
    ops._channels = {"agforge-agstudio1", "pj-mediagen", "front"}
    ops._live = live
    ops._reason = "live" if live else "event queue expired; resyncing"
    return ops


def snapshot_with(rosters, topics=(), live=True, retired=()):
    return ops_with(rosters, topics, live, retired).snapshot(now=NOW)


def test_an_instance_without_a_roster_block_is_unknown_not_idle():
    # Plan rule 3. p9's 26 silent minutes were indistinguishable from idle,
    # and a board that paints unknown green cannot show the one failure it
    # exists to catch.
    found = snapshot_with({"agping-agstudio1": None})
    summary = found["instances"][0]
    assert summary["state"] == "unknown" and summary["roster"] == "missing"
    row = found["rows"][0]
    assert row["state"] == "unknown"
    assert "no roster block" in row["provenance"]["text"]


def test_a_declared_channel_that_does_not_exist_is_reported_as_such():
    found = snapshot_with({"front-agstudio1": FRONT})
    summary = found["instances"][0]
    assert summary["channel"] == "front-agstudio1"
    assert summary["channel_exists"] is False


def test_a_dead_queue_makes_every_row_unknown_and_keeps_the_last_state_as_evidence():
    found = snapshot_with(
        {"agforge-agstudio1": FORGE},
        [topic("agforge-agstudio1", "assetplan-poster", message("please", ago=5000))],
        live=False,
    )
    assert found["health"]["state"] == "unknown"
    row = found["rows"][0]
    assert row["state"] == "unknown" and row["stale_state"] == "stalled"
    assert "the relay is not reading Zulip" in row["provenance"]["text"]
    assert found["instances"][0]["state"] == "unknown"


def test_stalled_rows_come_first():
    found = snapshot_with(
        {"agforge-agstudio1": FORGE},
        [
            topic("agforge-agstudio1", "fresh", message("please", ident=1, ago=10)),
            topic("agforge-agstudio1", "old", message("please", ident=2, ago=5000)),
            topic("agforge-agstudio1", "older", message("please", ident=3, ago=9000)),
        ],
    )
    assert [row["topic"] for row in found["rows"]] == ["older", "old", "fresh"]


# --- provenance ------------------------------------------------------------


def test_every_row_carries_the_evidence_its_state_was_read_off():
    found = snapshot_with(
        {"agforge-agstudio1": FORGE},
        [topic("agforge-agstudio1", "assetplan-poster", message("please", ident=42, ago=1020))],
    )
    provenance = found["rows"][0]["provenance"]
    assert provenance["message_id"] == 42
    assert provenance["route"] == "owner"
    assert provenance["served_mark"] is None
    assert provenance["text"].startswith("stalled — 17 min since Developer's post #42")


def test_the_provenance_line_names_the_served_note_when_there_is_one():
    row = {"state": "awaiting", "route": "mention", "age_seconds": 120.0,
           "message_id": 9, "message_at": 0, "by": "Developer", "served_mark": 5}
    assert "served note up to #5" in describe(row, "front-agstudio1", 15)


def test_a_card_sized_provenance_is_served_beside_the_sentence():
    # The panel's status line wraps at about 28 characters; the full sentence
    # renders as six lines and spills through the card's border, which is what
    # a screenshot found and no other check could.
    found = snapshot_with(
        {"agforge-agstudio1": FORGE},
        [topic("agforge-agstudio1", "assetplan-poster", message("please", ident=42, ago=1020))],
    )
    short = found["rows"][0]["provenance"]["short"]
    assert short == "17 min unanswered · #42 by Developer · no served note"
    assert len(short) < len(found["rows"][0]["provenance"]["text"])


def test_an_unknown_row_has_a_short_form_too():
    assert snapshot_with({"agping-agstudio1": None})["rows"][0]["provenance"]["short"]
    dead = snapshot_with(
        {"agforge-agstudio1": FORGE},
        [topic("agforge-agstudio1", "x", message("please", ago=5000))],
        live=False,
    )
    assert dead["rows"][0]["provenance"]["short"] == "relay not reading Zulip · last known stalled"


def test_a_shared_prefix_is_stated_rather_than_arbitrated():
    # A prefix says which *kind* of agent owns a topic, never which instance,
    # and both listeners really would sweep it. p1 read that as observer error
    # and charged one bot 59 phantom rows for it; the honest answer is two
    # rows that each name the other.
    other = Roster(instance="agforge-agautolab1", agent="agforge", bot="agforge-agautolab1",
                   bot_id=99, channel="agforge-agautolab1", prefixes=FORGE.prefixes)
    found = snapshot_with(
        {"agforge-agstudio1": FORGE, "agforge-agautolab1": other},
        [topic("pj-mediagen", "assetplan-poster", message("please", ago=5000))],
    )
    assert len(found["rows"]) == 2
    for row in found["rows"]:
        assert row["provenance"]["shared_with"] != [row["instance"]]
        assert "shared with" in row["provenance"]["text"]


def test_a_sibling_reaching_into_an_owned_channel_is_stated_on_both_rows():
    # The owner of the channel has no doubt that the topic is its own — but a
    # sibling's prefix reaches into any channel it is subscribed to, so the
    # sibling would sweep it too, and that is the surprising half.
    other = Roster(instance="agforge-agautolab1", agent="agforge", bot="agforge-agautolab1",
                   bot_id=99, channel="agforge-agautolab1", prefixes=FORGE.prefixes)
    found = snapshot_with(
        {"agforge-agstudio1": FORGE, "agforge-agautolab1": other},
        [topic("agforge-agstudio1", "assetplan-poster", message("please", ago=5000))],
    )
    mine = [r for r in found["rows"] if r["instance"] == "agforge-agstudio1"][0]
    theirs = [r for r in found["rows"] if r["instance"] == "agforge-agautolab1"][0]
    assert mine["provenance"]["shared_with"] == ["agforge-agautolab1"]
    # The sibling's own row has nobody to name: only prefix-owned rows are
    # collected, and the channel owner is not one of them.
    assert "shared_with" not in theirs["provenance"]


# --- confirm: the only way a row leaves this board -------------------------


def done_board(*, live=True):
    """One `done` row and one live `stalled` row, which is the whole question:
    the receipt may be dismissed and the debt beside it may not."""
    return ops_with(
        {"agforge-agstudio1": FORGE},
        [
            topic("agforge-agstudio1", "assetplan-poster",
                  message("thanks", ident=42, ago=60), resolved=True),
            topic("agforge-agstudio1", "assetrun-poster",
                  message("please", ident=43, ago=5000)),
        ],
        live=live,
    )


def states(found):
    return {row["topic"]: row["state"] for row in found["rows"]}


def test_confirming_hides_the_done_rows_and_nothing_else():
    ops = done_board()
    assert states(ops.snapshot(now=NOW)) == {
        "assetplan-poster": "done", "assetrun-poster": "stalled"}
    found = ops.confirm(now=NOW)
    assert found["confirmed"] == 1
    assert found["topics"] == [
        {"channel": "agforge-agstudio1", "topic": "assetplan-poster", "message_id": 42}]
    assert states(ops.snapshot(now=NOW)) == {"assetrun-poster": "stalled"}


def test_a_confirmed_row_stops_being_counted_for_its_agent():
    # The agent card reads its counts, so a hidden row that is still counted
    # would leave the board and the card disagreeing about the same debt.
    ops = done_board()
    assert ops.snapshot(now=NOW)["instances"][0]["counts"]["done"] == 1
    ops.confirm(now=NOW)
    summary = ops.snapshot(now=NOW)["instances"][0]
    assert summary["counts"]["done"] == 0
    assert summary["confirmed"] == 1


def test_live_debt_cannot_be_confirmed_and_the_relay_is_what_refuses():
    # The plan's first constraint, and the reason it is a constraint: a button
    # that clears `stalled` off the screen is p9's twenty-six unnoticed
    # minutes with a shortcut to it. The view hiding the button is not enough.
    ops = done_board()
    found = ops.confirm(("agforge-agstudio1", "assetrun-poster"), now=NOW)
    assert found["confirmed"] == 0 and found["refused"] == ["stalled"]
    assert states(ops.snapshot(now=NOW))["assetrun-poster"] == "stalled"


def test_confirming_one_topic_leaves_the_other_done_rows_alone():
    ops = ops_with(
        {"agforge-agstudio1": FORGE},
        [
            topic("agforge-agstudio1", "a", message("ok", ident=1, ago=60), resolved=True),
            topic("agforge-agstudio1", "b", message("ok", ident=2, ago=60), resolved=True),
        ],
    )
    ops.confirm(("agforge-agstudio1", "a"), now=NOW)
    assert list(states(ops.snapshot(now=NOW))) == ["b"]


def test_a_topic_that_is_not_on_the_board_is_not_silently_confirmed():
    ops = done_board()
    found = ops.confirm(("agforge-agstudio1", "never-existed"), now=NOW)
    assert found["confirmed"] == 0 and "no row for" in found["error"]


def test_a_new_post_floats_a_confirmed_row_back_up():
    # Why the mark is a message id and not a delete: confirm says "I have seen
    # this row", not "forget this conversation".
    ops = done_board()
    ops.confirm(now=NOW)
    assert "assetplan-poster" not in states(ops.snapshot(now=NOW))
    ops._topics[("agforge-agstudio1", "assetplan-poster")].add(
        message("one more thing", ident=99, ago=5))
    assert states(ops.snapshot(now=NOW))["assetplan-poster"] == "done"


def test_an_unresolve_brings_the_row_back_even_with_no_new_post():
    # The trap the plan names: a plain `del` from `_topics` would leave the
    # later rename with an `orig_subject` this engine no longer knows, and
    # `_apply_update` would drop it — a re-opened conversation nobody sees.
    ops = done_board()
    ops._stream_names = {7: "agforge-agstudio1"}
    ops.confirm(now=NOW)
    ops._apply({"type": "update_message", "stream_id": 7,
                "orig_subject": "✔ assetplan-poster", "subject": "assetplan-poster"})
    assert states(ops.snapshot(now=NOW))["assetplan-poster"] == "awaiting"


def test_confirm_acts_on_what_the_screen_shows_while_the_queue_is_dead():
    # Every row reads `unknown` then, with its last verdict in `stale_state`.
    # A `done` receipt is still dismissible; the stall beside it is still not.
    ops = done_board(live=False)
    assert states(ops.snapshot(now=NOW)) == {
        "assetplan-poster": "unknown", "assetrun-poster": "unknown"}
    assert ops.confirm(("agforge-agstudio1", "assetrun-poster"), now=NOW)["refused"] == ["stalled"]
    ops.confirm(now=NOW)
    assert list(states(ops.snapshot(now=NOW))) == ["assetrun-poster"]


def test_the_board_says_how_much_it_is_hiding():
    ops = done_board()
    ops.confirm(now=NOW)
    assert ops.snapshot(now=NOW)["confirmed"] == {"rows": 1, "topics": 1}


# --- retirement: a ✔ on an introduction ------------------------------------


def test_a_retired_agent_leaves_the_board_and_the_payload_says_why():
    # p2 ex2 step C. `agping-agstudio1` sat amber for a whole phase because
    # its project existed on no machine and so could never re-post a roster.
    # The realm's answer is a ✔ on its introduction; the board's answer is to
    # stop drawing it — but to *name* it, because an agent that vanishes with
    # no account of itself is the failure this board exists to prevent.
    found = snapshot_with(
        {"agping-agstudio1": None, "agforge-agstudio1": FORGE},
        retired=["agping-agstudio1"],
    )
    assert found["retired"] == ["agping-agstudio1"]
    assert [i["instance"] for i in found["instances"]] == ["agforge-agstudio1"]
    assert found["rows"] == []


def test_retiring_an_agent_does_not_retire_the_rest():
    found = snapshot_with({"agping-agstudio1": None}, retired=["agecho-agstudio1"])
    assert found["retired"] == ["agecho-agstudio1"]
    assert [i["instance"] for i in found["instances"]] == ["agping-agstudio1"]


def test_resolving_an_introduction_retires_the_agent_without_a_resweep():
    # The same courtesy `_apply_message` pays a re-posted introduction: the
    # contract says the realm is the authority, and an observer that needs a
    # restart to notice has not honoured it.
    ops = ops_with({"agping-agstudio1": None})
    ops._stream_names = {35: "agents"}
    ops._apply({"type": "update_message", "stream_id": 35,
                "orig_subject": "intro-agping-agstudio1",
                "subject": "✔ intro-agping-agstudio1"})
    assert ops._retired == {"agping-agstudio1"}
    assert ops.snapshot(now=NOW)["rows"] == []


def test_un_resolving_an_introduction_brings_the_agent_back():
    # Retirement is a flag read off the realm, not a deletion — the mistake
    # `confirm` avoided for the same reason in ex1.
    ops = ops_with({"agping-agstudio1": None}, retired=["agping-agstudio1"])
    ops._stream_names = {35: "agents"}
    ops._apply({"type": "update_message", "stream_id": 35,
                "orig_subject": "✔ intro-agping-agstudio1",
                "subject": "intro-agping-agstudio1"})
    assert ops._retired == set()
    assert [row["instance"] for row in ops.snapshot(now=NOW)["rows"]] == ["agping-agstudio1"]


def test_a_resolve_elsewhere_retires_nobody():
    ops = ops_with({"agforge-agstudio1": FORGE},
                   [topic("agforge-agstudio1", "assetplan-poster", message("please"))])
    ops._stream_names = {7: "agforge-agstudio1"}
    ops._apply({"type": "update_message", "stream_id": 7,
                "orig_subject": "assetplan-poster", "subject": "✔ assetplan-poster"})
    assert ops._retired == set()
