"""The routine board's rules, against made-up routines (`refine_routine` p1).

A routine is a channel with a `guide` topic and `routinerun-` topics. What
is pinned here is how the board reads them: which topics belong, which post
is the guide, what the opening post and the origin of a run are, where a run
stands from its own posts, how it finished, and that the chat door posts
only into a routine's own conversations while a run request goes to Front's
entrance.
"""

import json
from pathlib import Path

from agentroom.chat import Chat, allowed_topic, request_text
from agentroom.inflight import Inflight, parse_roots
from agentroom.ops import Topic
from agentroom.routines import (
    DEEP_RUNS,
    display_of,
    finish_of,
    guide_of,
    is_routine_topic,
    newest_run_topics,
    opening_of,
    origin_of,
    routine_name,
    routine_rows,
    run_state,
    run_topics_of,
    session_list,
    session_tree,
    sessions_of,
)

NOW = 1_800_000_000.0
STALL = 900.0
DEVELOPER = 8
FRONT = 15
AUTOLAB = 11
ACK = "Message received. Please wait for the reply."
CHANNEL = "routine-papers"
RUN = "routinerun-20260909-1500"
OPENING = ("Routine run opened. Requested in #front › front-desk-20260909-1459 (message 5500): "
           "\"run papers once\". Conditions: one paper; done when autolab reports the commit. "
           "Guide: #routine-papers › guide, message 5499.")
FINISH = ("Autolab reported commit 1a2b3c4 (#work-s5-1 › workrun-task1-s5-1 #7).\n\n"
          "```ag-routinerun\n"
          "{\"schema\": \"ag.routinerun-finish.v1\", \"achieved\": true, "
          "\"reason\": \"the paper is summarised and committed\", "
          "\"report\": \"2609.01234 summarised; commit 1a2b3c4\"}\n```")


def message(content, *, ident=1, sender_id=DEVELOPER, sender="Developer", ago=0.0):
    return {
        "id": ident,
        "sender_id": sender_id,
        "sender_full_name": sender,
        "sender_realm_str": "agdev",
        "timestamp": int(NOW - ago),
        "content": content,
    }


def by_front(content, *, ident, ago=0.0):
    return message(content, ident=ident, sender_id=FRONT, sender="Front", ago=ago)


def origin_note(ident=9, home="front/front-desk-20260909-1459"):
    return by_front(f"[selfnote][rootchat] {home}", ident=ident)


def history_of(*messages):
    found = Topic(channel=CHANNEL, topic=RUN, live_topic=RUN, keep_history=True)
    for one in messages:
        found.add(one)
    return sorted(found.history, key=lambda post: post.id)


def topic(channel, name, *messages, resolved=False, keep=True):
    live = f"✔ {name}" if resolved else name
    found = Topic(channel=channel, topic=name, live_topic=live, resolved=resolved, keep_history=keep)
    for one in messages:
        found.add(one)
    return found


def run(name, *messages, resolved=False):
    return topic(CHANNEL, name, *messages, resolved=resolved)


# --- which topics belong ----------------------------------------------------


def test_a_routines_guide_and_run_topics_are_recognised_and_nothing_else_is():
    assert is_routine_topic(CHANNEL, "guide")
    assert is_routine_topic(CHANNEL, "✔ guide")
    assert is_routine_topic(CHANNEL, RUN)
    assert is_routine_topic(CHANNEL, f"✔ {RUN}")
    assert not is_routine_topic(CHANNEL, "some other topic")
    assert not is_routine_topic("front", RUN)
    assert not is_routine_topic("front", "routine-papers")  # the pre-p1 standing request
    assert not is_routine_topic("front", "front-routine-papers-2026-09-06T00:00Z")


def test_the_name_is_the_channel_s():
    assert routine_name(CHANNEL) == "papers"
    assert routine_name("routine-study-realworld") == "study-realworld"
    assert routine_name("front") is None and routine_name("routine-") is None


def test_run_topics_sort_newest_first_by_opening_id_and_the_newest_few_are_the_deep_ones():
    topics = {
        (CHANNEL, "routinerun-a"): run("routinerun-a", by_front(OPENING, ident=100)),
        (CHANNEL, "routinerun-b"): run("routinerun-b", by_front(OPENING, ident=300)),
        (CHANNEL, "routinerun-c"): run("routinerun-c", by_front(OPENING, ident=200), resolved=True),
        (CHANNEL, "guide"): topic(CHANNEL, "guide", message("the guide", ident=50)),
        ("routine-other", "routinerun-x"): topic("routine-other", "routinerun-x", by_front(OPENING, ident=400)),
    }
    assert [found.topic for found in run_topics_of(topics, "papers")] == ["routinerun-b", "routinerun-c", "routinerun-a"]
    # The realm lists topics newest-activity first; the first DEEP_RUNS run
    # topics of that listing are the deep ones, ✔ included.
    listing = ["guide", "✔ routinerun-d", "routinerun-c", "routinerun-b", "routinerun-a"]
    assert newest_run_topics(listing) == {"routinerun-d", "routinerun-c", "routinerun-b"}
    assert DEEP_RUNS == 3


# --- the guide ------------------------------------------------------------------


def test_the_guide_is_the_newest_post_whole():
    found = guide_of(history_of(message("guide v1", ident=1), message("guide v2", ident=2)))
    assert found["message_id"] == 2 and found["text"] == "guide v2"
    assert found["posts"] == 2 and found["authors"] == ["Developer"]


def test_a_post_by_somebody_else_in_the_guide_is_still_the_guide_and_is_visible_as_such():
    found = guide_of(history_of(message("guide v1", ident=1), by_front("a stray report", ident=2)))
    assert found["text"] == "a stray report" and found["authors"] == ["Developer", "Front"]


def test_a_tick_on_the_guide_retires_the_routine():
    rows = routine_rows({(CHANNEL, "guide"): topic(CHANNEL, "guide", message("g", ident=1), resolved=True)},
                        NOW, stalled_seconds=STALL)
    assert rows[0]["retired"] is True and rows[0]["state"] == "retired"


def test_a_routine_channel_with_no_topic_yet_still_gets_a_row():
    rows = routine_rows({}, NOW, stalled_seconds=STALL, channels=["routine-new", "front", "pj-x"])
    assert [row["name"] for row in rows] == ["new"]
    assert rows[0]["guide"] is None and rows[0]["state"] == "idle" and rows[0]["latest"] is None


# --- a run's own posts ----------------------------------------------------------


def test_the_opening_post_is_the_oldest_real_post_and_the_origin_is_front_s_root_note():
    found = run(RUN, origin_note(), by_front(OPENING, ident=10))
    assert opening_of(found.history)["message_id"] == 10
    assert opening_of(found.history)["text"].startswith("Routine run opened")
    assert origin_of(found) == {"channel": "front", "topic": "front-desk-20260909-1459",
                                "by": "Front", "by_id": FRONT, "message_id": 9}
    assert "selfnote" not in " ".join(post.content for post in found.history)


def test_a_run_opened_by_hand_has_no_origin():
    found = run(RUN, message("run papers, please", ident=10))
    assert origin_of(found) is None
    assert opening_of(found.history)["by"] == "Developer"


def test_run_states_read_off_the_posts():
    def state(*messages, resolved=False):
        found = run(RUN, *messages, resolved=resolved)
        return run_state(found.history, found, NOW, stalled_seconds=STALL)["state"]

    assert state(origin_note(), by_front(OPENING, ident=10)) == "unstarted"
    assert state(by_front(OPENING, ident=10), by_front(ACK, ident=11)) == "acked"
    assert state(by_front(OPENING, ident=10), by_front(ACK, ident=11),
                 by_front("asked autolab; waiting", ident=12)) == "waiting"
    # Somebody else posted after Front's entry: Front owes an answer, in the
    # ops board's own words.
    assert state(by_front(OPENING, ident=10), by_front(ACK, ident=11), by_front("waiting", ident=12),
                 message("please stop", ident=13, ago=60)) == "awaiting"
    assert state(by_front(OPENING, ident=10), by_front(ACK, ident=11), by_front("waiting", ident=12),
                 message("please stop", ident=13, ago=STALL + 1)) == "stalled"
    assert state(by_front(OPENING, ident=10), by_front(ACK, ident=11), by_front(FINISH, ident=12)) == "finished"
    assert state(by_front(OPENING, ident=10), by_front(ACK, ident=11), by_front("ended by hand", ident=12),
                 resolved=True) == "finished"
    # A run opened by hand is unstarted until Front serves it, like any other.
    assert state(message("run papers", ident=10)) == "unstarted"
    assert state() == "unknown"


def test_the_finish_is_the_block_s_verdict_with_where_it_was_said():
    found = finish_of(history_of(by_front(OPENING, ident=10), by_front(ACK, ident=11), by_front(FINISH, ident=12)))
    assert found["achieved"] is True and found["reason"] == "the paper is summarised and committed"
    assert found["report"] == "2609.01234 summarised; commit 1a2b3c4" and found["message_id"] == 12
    # A block of another schema, or a broken one, is not a finish.
    assert finish_of(history_of(by_front("```ag-routinerun\n{\"schema\": \"x\"}\n```", ident=12))) is None
    assert finish_of(history_of(by_front("```ag-routinerun\nnot json\n```", ident=12))) is None


def test_a_selfnote_is_not_history_and_never_reaches_the_view():
    found = run(RUN, origin_note(), by_front(OPENING, ident=10), by_front("[selfnote][served] work-x/y 3", ident=11))
    assert [post.id for post in found.history] == [10]
    session = sessions_of({(CHANNEL, RUN): found}, "papers", {}, now=NOW)[0]
    assert "selfnote" not in json.dumps(session)


# --- the board ------------------------------------------------------------------


def rows(*topics, now=NOW, channels=()):
    return routine_rows({(one.channel, one.topic): one for one in topics}, now,
                        stalled_seconds=STALL, channels=channels)


def test_a_routine_row_carries_its_guide_and_its_latest_run():
    guide = topic(CHANNEL, "guide", message("display: 📰 Papers digest\nthe guide", ident=1))
    older = run("routinerun-a", by_front(OPENING, ident=10), by_front(ACK, ident=11), by_front(FINISH, ident=12), resolved=True)
    latest = run(RUN, origin_note(ident=19), by_front(OPENING, ident=20), by_front(ACK, ident=21),
                 by_front("asked autolab in #pj-papers › workplan-x; waiting", ident=22))
    row = rows(guide, older, latest)[0]
    assert row["name"] == "papers" and row["channel"] == CHANNEL
    assert row["guide"]["message_id"] == 1 and row["guide_topic"] == "guide"
    assert row["display"] == {"icon": "📰", "icon_source": "metadata", "title": "Papers digest", "title_source": "metadata"}
    assert row["runs"] == 2 and row["open_runs"] == 1 and row["latest_topic"] == RUN
    assert row["latest"]["run"]["state"] == "waiting" and row["state"] == "waiting"
    assert row["latest"]["origin"]["topic"] == "front-desk-20260909-1459"
    assert row["latest"]["finish"] is None and row["retired"] is False


def test_a_finished_latest_run_says_whether_the_goal_was_reached():
    latest = run(RUN, by_front(OPENING, ident=20), by_front(ACK, ident=21), by_front(FINISH, ident=22), resolved=True)
    row = rows(topic(CHANNEL, "guide", message("g", ident=1)), latest)[0]
    assert row["state"] == "finished"
    assert row["latest"]["finish"]["achieved"] is True and row["latest"]["resolution"]["state"] == "resolved"


def test_assigned_icons_do_not_collide_on_one_board():
    board = rows(*(topic(f"routine-{name}", "guide", message("g", ident=i + 1))
                   for i, name in enumerate(["a", "b", "c", "d", "e", "f"])))
    icons = [row["display"]["icon"] for row in board]
    assert len(icons) == len(set(icons)) and all(row["display"]["icon_source"] == "assigned" for row in board)


def test_a_first_line_heading_is_the_next_title_and_the_name_is_last():
    assert display_of("papers", "# 🧪 Daily papers\nbody")["title"] == "Daily papers"
    assert display_of("papers", "# 🧪 Daily papers\nbody")["icon"] == "🧪"
    assert display_of("papers", "**Routine `papers` — guide v1** …")["title_source"] == "name"


# --- the session tree ------------------------------------------------------------


def rootnote(home, *, ident, sender_id=FRONT, sender="Front"):
    return message(f"[selfnote][rootchat] {home}", ident=ident, sender_id=sender_id, sender=sender)


def servednote(remote, remote_id, *, ident, sender_id=FRONT, sender="Front"):
    return message(f"[selfnote][served] {remote} {remote_id}", ident=ident, sender_id=sender_id, sender=sender)


def mapping(*topics):
    return {(one.channel, one.topic): one for one in topics}


def test_a_rootchat_note_in_the_delegate_finds_a_child_nothing_has_answered_yet():
    topics = mapping(
        run(RUN, origin_note(), by_front(OPENING, ident=10), by_front(ACK, ident=11), by_front("asked", ident=12)),
        topic("pj-papers", "workplan-x", rootnote(f"{CHANNEL}/{RUN}", ident=20),
              message("planned", ident=21, sender_id=AUTOLAB, sender="autolab-agstudio1")),
    )
    tree = session_tree(topics, (CHANNEL, RUN), {}, since=0, until=None)
    assert [(n["channel"], n["topic"], n["via"]) for n in tree["nodes"]] == [("pj-papers", "workplan-x", "rootchat")]
    assert tree["nodes"][0]["state"] == "quiet"


def test_a_served_note_in_the_run_finds_a_child_that_was_resolved_and_never_swept():
    topics = mapping(run(RUN, by_front(OPENING, ident=10), by_front(ACK, ident=11),
                         servednote("work-s5-1/workrun-task1-s5-1", 7, ident=12)))
    tree = session_tree(topics, (CHANNEL, RUN), {}, since=0, until=None)
    assert [(n["topic"], n["via"], n["known"], n["state"]) for n in tree["nodes"]] == [
        ("workrun-task1-s5-1", "served", "note-only", "unknown")]


def test_the_run_s_origin_is_not_a_child_of_the_run():
    """The desk's root note is *in the run* and names the desk: it says
    where the run came from, and must not make the desk a conversation the
    run opened."""
    desk = topic("front", "front-desk-20260909-1459", message("run papers", ident=1))
    topics = mapping(desk, run(RUN, origin_note(), by_front(OPENING, ident=10)))
    tree = session_tree(topics, (CHANNEL, RUN), {}, since=0, until=None)
    assert tree["nodes"] == []
    # Seen from the desk, the run *is* one of its children — the desk opened it.
    desk_tree = session_tree(topics, ("front", "front-desk-20260909-1459"), {}, since=0, until=None)
    assert [(n["channel"], n["topic"]) for n in desk_tree["nodes"]] == [(CHANNEL, RUN)]


def test_a_session_carries_opening_origin_entries_finish_and_chat():
    topics = mapping(
        run(RUN, origin_note(), by_front(OPENING, ident=10), by_front(ACK, ident=11),
            by_front("asked autolab", ident=12), by_front(ACK, ident=13), by_front(FINISH, ident=14), resolved=True),
        topic("pj-papers", "workplan-x", rootnote(f"{CHANNEL}/{RUN}", ident=20)),
    )
    listed = session_list(topics, "papers", {}, now=NOW)
    session = listed["sessions"][0]
    assert session["channel"] == CHANNEL and session["topic"] == RUN and session["id"] == 10
    assert session["opened"]["message_id"] == 10 and session["origin"]["topic"] == "front-desk-20260909-1459"
    assert session["entries"] == 3 and session["last_entry"]["message_id"] == 14
    assert session["finish"]["achieved"] is True and session["finish"]["report"].startswith("2609.01234")
    assert session["run"]["state"] == "finished" and session["resolution"]["state"] == "resolved"
    assert [post["message_id"] for post in session["chat"]] == [10, 11, 12, 13, 14]
    assert [n["topic"] for n in session["nodes"]] == ["workplan-x"]
    assert listed["latest_topic"] == RUN and listed["history"]["runs"] == 1


def test_only_the_last_three_runs_are_listed_and_hiding_resolved_filters_first():
    runs = [run(f"routinerun-{i}", by_front(OPENING, ident=i * 10), resolved=(i % 2 == 0)) for i in range(1, 6)]
    topics = mapping(*runs)
    assert [s["topic"] for s in session_list(topics, "papers", {}, now=NOW)["sessions"]] == [
        "routinerun-5", "routinerun-4", "routinerun-3"]
    hidden = session_list(topics, "papers", {}, now=NOW, include_resolved=False)
    assert [s["topic"] for s in hidden["sessions"]] == ["routinerun-5", "routinerun-3", "routinerun-1"]
    assert hidden["history"]["hidden_resolved"] == 2


# --- the chat door ------------------------------------------------------------------


def test_chat_posts_only_into_a_known_routine_s_own_conversations():
    names = {"papers"}
    assert allowed_topic(CHANNEL, "guide", names)
    assert allowed_topic(CHANNEL, RUN, names)
    assert not allowed_topic(CHANNEL, "anything else", names)
    assert not allowed_topic("routine-ghosts", "guide", names)
    assert not allowed_topic("front", "front-desk-1", names)
    assert not allowed_topic("pj-papers", "workplan-x", names)


def test_an_unconfigured_chat_refuses_and_says_which_variable():
    found = Chat(env_path=None).check(CHANNEL, RUN, "hello", {"papers"})
    assert "AGENTROOM_CHAT_ZULIP_ENV" in found


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


def test_a_sent_message_goes_into_the_routine_s_channel_and_reports_its_id(tmp_path):
    chat, client = started_chat(tmp_path)
    found = chat.send(CHANNEL, RUN, " a word to the run ", {"papers"})
    assert found == {"sent": True, "channel": CHANNEL, "topic": RUN, "message_id": 5100,
                     "note": "the post is live in the realm; the event queue will carry it back"}
    assert client.sent == [(CHANNEL, RUN, "a word to the run")]


def test_a_refused_message_is_never_posted(tmp_path):
    chat, client = started_chat(tmp_path)
    assert chat.send("front", "front-desk-1", "hi", {"papers"})["sent"] is False
    assert chat.send(CHANNEL, RUN, "[selfnote][rootchat] x/y", {"papers"})["sent"] is False
    chat.max_chars = 10
    assert "over the 10" in chat.send(CHANNEL, RUN, "x" * 11, {"papers"})["error"]
    assert client.sent == []


# --- asking Front to run a routine ------------------------------------------


def live_row(**overrides):
    row = {"name": "papers", "retired": False, "latest_topic": RUN,
           "guide": {"message_id": 1, "text": "the guide"}}
    row.update(overrides)
    return row


def test_a_run_request_is_posted_at_front_s_entrance_as_a_desk_conversation(tmp_path):
    chat, client = started_chat(tmp_path)
    found = chat.request(live_row(), "papers", " one paper only ", stamp="20260909-150000")
    assert found["sent"] is True and found["message_id"] == 5100
    assert (found["channel"], found["topic"], found["desk"]) == ("front", "front-desk-20260909-150000", "20260909-150000")
    channel, topic, text = client.sent[0]
    assert (channel, topic) == ("front", "front-desk-20260909-150000")
    assert text == found["text"] == request_text("papers", "one paper only")
    assert "#routine-papers › `guide`" in text and "Conditions for this run: one paper only" in text
    assert "go ahead without asking" in text


def test_a_request_without_conditions_says_only_which_routine(tmp_path):
    chat, client = started_chat(tmp_path)
    chat.request(live_row(), "papers", None, stamp="20260909-150000")
    assert "Conditions" not in client.sent[0][2]


def test_a_retired_or_guideless_routine_is_refused_before_anything_is_posted(tmp_path):
    chat, client = started_chat(tmp_path)
    retired = chat.request(live_row(retired=True), "papers", None, stamp="20260909-150000")
    assert retired["sent"] is False and "retired" in retired["error"] and "guide" in retired["error"]
    blank = chat.request(live_row(guide=None), "papers", None, stamp="20260909-150000")
    assert blank["sent"] is False and "no guide" in blank["error"]
    unknown = chat.request(None, "ghosts", None, stamp="20260909-150000")
    assert unknown["sent"] is False and "ghosts" in unknown["error"]
    assert client.sent == []


def test_an_unconfigured_relay_refuses_to_ask_and_names_the_variable(tmp_path):
    found = Chat(env_path=None).request(live_row(), "papers", None, stamp="20260909-150000")
    assert found["sent"] is False and "AGENTROOM_CHAT_ZULIP_ENV" in found["error"]


def test_a_failed_post_is_reported_as_uncertain_and_never_retried(tmp_path):
    chat, client = started_chat(tmp_path, RecordingClient(fail=ConnectionError("reset")))
    found = chat.request(live_row(), "papers", None, stamp="20260909-150000")
    assert found["sent"] is False and found["uncertain"] is True and "may have landed" in found["note"]


def test_an_over_long_instruction_is_refused_like_any_other_post(tmp_path):
    chat, client = started_chat(tmp_path)
    chat.max_chars = 300
    found = chat.request(live_row(), "papers", "x" * 300, stamp="20260909-150000")
    assert found["sent"] is False and found["uncertain"] is False and client.sent == []


# --- the host-side in-flight signal (unchanged by p1) --------------------------


def workspace(root, channel, topic, generation, role="front"):
    path = root / ".local" / "topics" / channel / topic / str(generation) / role
    path.mkdir(parents=True)
    (path / "chatlog.md").write_text("x")
    return path


def record(root, role, number, *, at):
    import os
    path = root / ".local" / "agent" / role / f"run-{number:04d}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}")
    os.utime(path, (at, at))
    return path


def test_roots_are_parsed_as_instances_because_an_agent_runs_on_more_than_one_node():
    assert parse_roots("front-agstudio1=/a, autolab-agstudio1=/b") == {
        "front-agstudio1": Path("/a"), "autolab-agstudio1": Path("/b")}


def test_a_workspace_newer_than_every_run_record_is_a_run_in_flight(tmp_path):
    import os
    root = tmp_path / "front"
    path = workspace(root, CHANNEL, RUN, 1)
    record(root, "routine_run", 1, at=NOW - 100)
    os.utime(path, (NOW, NOW))
    found = Inflight(roots={"front-agstudio1": root}).look("front-agstudio1", CHANNEL, RUN)
    assert found["known"] is True and found["in_flight"] is True
