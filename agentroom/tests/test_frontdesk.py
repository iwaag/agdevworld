"""The Front Desk door, against made-up conversations (`front_desk` p1).

What is pinned: history comes back from the engine's memory *or* from a
direct read of Zulip, resolved topics included, and says which; the states
are read off the realm's own facts (Front's ack, Front's id, Zulip's ✔); the
write refuses the wrong destination, an over-long text, a selfnote and a
repeated submit token; a failed post is uncertain and never retried; a ✔'d
conversation is resumed in place. Nothing here touches Zulip.
"""

import json
import threading
from http.client import HTTPConnection

from agag.intro import Roster
from conftest import FakeRealm, empty_room, mirror_over

from agentroom.chat import Chat
from agentroom.frontdesk import (
    DESK_DEEP, FrontDesk, is_desk_topic, newest_desk_topics, post_kind, shown_content, status_of,
)
from agentroom.ops import Ops, Topic
from agentroom.room import Room
from agentroom.server import build_server

NOW = 1_800_000_000.0
DEVELOPER, FRONT_BOT = 8, 15
ACK = "Message received. Please wait for the reply."
FRONT = Roster(instance="front-agstudio1", agent="front", bot="Front", bot_id=FRONT_BOT,
               channel="front-agstudio1", prefixes=("front-",))
DESK = "front-desk-20260908-1600"


def message(content, *, ident, sender_id=DEVELOPER, sender="Developer", ago=0.0, realm="agdev"):
    return {"id": ident, "sender_id": sender_id, "sender_full_name": sender,
            "sender_realm_str": realm, "timestamp": int(NOW - ago), "content": content}


def by_front(content, *, ident, ago=0.0):
    return message(content, ident=ident, sender_id=FRONT_BOT, sender="Front", ago=ago)


def topic(name, *messages, resolved=False, keep=True):
    live = f"✔ {name}" if resolved else name
    found = Topic(channel="front", topic=name, live_topic=live, resolved=resolved, keep_history=keep)
    for one in messages:
        found.add(one)
    return found


class RecordingClient:
    """The chat credential: posts, un-resolves, knows who it is."""

    def __init__(self, fail=None):
        self.sent, self.patched, self.fail = [], [], fail

    def whoami(self):
        return {"user_id": DEVELOPER, "full_name": "Developer"}

    def send_to_channel(self, channel, topic, content):
        if self.fail:
            raise self.fail
        self.sent.append((channel, topic, content))
        return 6000 + len(self.sent)

    def call(self, method, path, params=None):
        self.patched.append((method, path, params))
        return {}


ROSTER = """```agag-roster
schema: ag.agent-roster.v1
instance: front-agstudio1
agent: front
bot: Front
bot_id: 15
channel: front-agstudio1
prefixes: front-
```"""


def engine(*topics, live=True, names=None):
    front_names = {t.topic: t.live_topic for t in topics}
    front_names.update(names or {})
    return Ops().pin(rosters={"front-agstudio1": FRONT}, topics=topics, front_names=front_names,
                     channels={"front"}, live=live)


def mirrored_desk(*posts, resolved=False, chat_client=None):
    """A real mirror holding one Front Desk conversation, and the desk over
    it. `posts` are `(sender_id, sender, content)`."""
    realm = FakeRealm()
    realm.base_url = "https://zulip.invalid"
    realm.add_channel(35, "agents")
    realm.add_channel(5, "front")
    realm.post("agents", "intro-front-agstudio1", "hello\n" + ROSTER, sender_id=FRONT_BOT, sender_name="Front", quiet=True)
    ids = [realm.post("front", DESK, content, sender_id=sender_id, sender_name=sender, quiet=True)
           for sender_id, sender, content in posts]
    if resolved:
        realm.resolve("front", DESK, quiet=True)
    mirror = mirror_over(realm)
    client = chat_client or RecordingClient()
    chat = Chat(env_path=__file__, client_factory=lambda path: client)
    return FrontDesk(ops=Ops(mirror=mirror), chat=chat), client, ids


def desk_with(*topics, live=True, names=None, chat_client=None, configured=True):
    client = chat_client or RecordingClient()
    chat = Chat(env_path=(__file__ if configured else None), client_factory=lambda path: client)
    desk = FrontDesk(ops=engine(*topics, live=live, names=names), chat=chat)
    return desk, client


# --- which topics, and what they are --------------------------------------


def test_a_front_desk_topic_is_in_front_under_the_prefix_and_nothing_else_is():
    assert is_desk_topic("front", DESK)
    assert is_desk_topic("front", f"✔ {DESK}")
    assert not is_desk_topic("front", "front-routine-ghtrends-2026-09-07T07:00Z")
    assert not is_desk_topic("front", "front-p3-greet-agping")
    assert not is_desk_topic("pj-ghtrends", DESK)


def test_the_newest_desk_conversations_are_the_deep_ones():
    names = [f"front-desk-2026090{i}-1200" for i in range(10)] + ["routine-ghtrends", "front-schedule"]
    deep = newest_desk_topics(names)
    assert len(deep) == DESK_DEEP
    assert "front-desk-20260909-1200" in deep and "front-desk-20260900-1200" not in deep


def test_a_post_is_an_ack_by_its_text_and_front_s_by_its_sender():
    held = topic(DESK, message("hi", ident=1), by_front(ACK, ident=2), by_front("やっほー✨", ident=3),
                 message("[selfnote][served] a/b 1", ident=4, sender_id=FRONT_BOT, sender="Front"))
    kinds = [post_kind(m, FRONT_BOT, DEVELOPER) for m in held.history]
    assert kinds == ["developer", "ack", "agent"]  # the selfnote never entered the history


def test_states_are_read_off_the_newest_real_post():
    assert status_of(topic(DESK), FRONT_BOT, DEVELOPER)["state"] == "quiet"
    assert status_of(topic(DESK, message("hi", ident=1)), FRONT_BOT, DEVELOPER)["state"] == "waiting"
    assert status_of(topic(DESK, message("hi", ident=1), by_front(ACK, ident=2)),
                     FRONT_BOT, DEVELOPER)["state"] == "received"
    assert status_of(topic(DESK, message("hi", ident=1), by_front(ACK, ident=2), by_front("yo", ident=3)),
                     FRONT_BOT, DEVELOPER)["state"] == "answered"
    # A second Developer post after the answer is waiting again.
    assert status_of(topic(DESK, by_front("yo", ident=3), message("and?", ident=4)),
                     FRONT_BOT, DEVELOPER)["state"] == "waiting"
    assert status_of(topic(DESK, by_front("yo", ident=3), resolved=True), FRONT_BOT, DEVELOPER)["state"] == "done"


def test_a_system_notice_is_not_somebody_speaking():
    """Un-resolving a topic makes Zulip post a notice; it must not read as
    the Developer waiting (`0a33830`)."""
    held = topic(DESK, by_front("yo", ident=3),
                 message("marked this topic as unresolved", ident=4, sender_id=99,
                         sender="Notification Bot", realm="zulipinternal"))
    assert status_of(held, FRONT_BOT, DEVELOPER)["state"] == "answered"


def test_the_handoff_mention_is_transport_and_is_not_shown():
    """Every reply Front posts begins `@**Developer**` — the skeleton's
    turn-taking, not something Front said. The live first reply showed it raw."""
    assert shown_content("@**Developer**\n\nやっほー✨\n\n@**autolab** is named here") == "やっほー✨\n\n@**autolab** is named here"
    assert shown_content("plain") == "plain"
    held = topic(DESK, by_front("@**Developer**\n\nyo", ident=3))
    desk, _ = desk_with(held)
    assert desk.conversation("20260908-1600", now=NOW)["conversation"]["latest_reply"]["content"] == "yo"


# --- history: held, read, unknown -------------------------------------------


def test_a_held_conversation_comes_from_the_engine_with_acks_marked_and_the_latest_reply():
    held = topic(DESK, message("hi", ident=1), by_front(ACK, ident=2), by_front("やっほー✨", ident=3),
                 message("more?", ident=4), by_front(ACK, ident=5))
    desk, _ = desk_with(held)
    found = desk.conversation("20260908-1600", now=NOW)
    conversation = found["conversation"]
    assert conversation["known"] == "held"
    assert [p["kind"] for p in conversation["posts"]] == ["developer", "ack", "agent", "developer", "ack"]
    assert conversation["latest_reply"]["content"] == "やっほー✨"
    assert conversation["status"]["state"] == "received"
    assert conversation["history"] == {"posts": 5, "bounded": False,
                                       "note": "every real post of this conversation is here"}
    assert found["chat"]["configured"] is True


def test_a_resolved_conversation_is_held_by_the_mirror_under_its_resolved_name():
    """After a relay restart an old ✔'d conversation used to be read once
    from the realm; the mirror holds every conversation, resolved ones
    included, so it is simply held."""
    desk, _, _ = mirrored_desk((DEVELOPER, "Developer", "hi"), (FRONT_BOT, "Front", "bye✨"), resolved=True)
    found = desk.conversation("20260908-1600", now=NOW)["conversation"]
    assert found["known"] == "held"
    assert found["resolved"] is True and found["live_topic"] == f"✔ {DESK}"
    assert [p["content"] for p in found["posts"]] == ["hi", "bye✨"]
    assert found["status"]["state"] == "done"
    assert found["zulip_url"].startswith("https://zulip.invalid/#narrow/channel/5-front/topic/")
    # No Zulip call was made for any of it.
    assert desk.mirror.health()["ledger"].get("hydrate GET messages") is None


def test_a_conversation_nobody_can_read_is_unknown_not_empty():
    desk, _ = desk_with()
    found = desk.conversation("20260908-1600", now=NOW)["conversation"]
    assert found["known"] == "unknown" and found["posts"] == []
    assert "cannot be read" in found["history"]["note"]
    without = FrontDesk(ops=engine(), chat=Chat(env_path=None))
    assert without.conversation("20260908-1600", now=NOW)["conversation"]["known"] == "unknown"


def test_a_dead_queue_turns_a_held_state_unknown_and_keeps_the_history():
    held = topic(DESK, message("hi", ident=1), by_front("yo", ident=2))
    desk, _ = desk_with(held, live=False)
    found = desk.conversation("20260908-1600", now=NOW)
    assert found["health"]["state"] == "unknown"
    assert found["conversation"]["status"]["state"] == "unknown"
    assert found["conversation"]["stale_state"] == "answered"
    assert len(found["conversation"]["posts"]) == 2


def test_the_board_lists_held_and_name_only_conversations_newest_first():
    older = topic("front-desk-20260901-0900", message("old", ident=1, ago=3600))
    newer = topic(DESK, message("new", ident=2))
    desk, _ = desk_with(older, newer, names={"front-desk-20260801-0800": "✔ front-desk-20260801-0800"})
    board = desk.board(now=NOW)
    rows = board["conversations"]
    assert [row["id"] for row in rows] == ["20260908-1600", "20260901-0900", "20260801-0800"]
    assert rows[2]["resolved"] is True and rows[2]["status"]["state"] == "done"
    assert "not held" in rows[2]["status"]["evidence"]
    assert board["prefix"] == "front-desk-" and board["channel"] == "front"


def test_a_bad_id_is_refused_before_anything_is_looked_up():
    desk, _ = desk_with()
    assert "error" in desk.conversation("../etc", now=NOW)
    assert "error" in desk.conversation("Upper", now=NOW)


# --- the write ---------------------------------------------------------------


def test_a_post_goes_to_the_desk_topic_as_the_developer_once():
    desk, client = desk_with(topic(DESK, message("hi", ident=1)))
    found = desk.post("20260908-1600", "  やっほー！ ", "tok-1")
    assert found["sent"] is True and found["topic"] == DESK and found["resumed"] is False
    assert client.sent == [("front", DESK, "やっほー！")]
    assert client.patched == []


def test_a_repeated_token_repeats_the_result_and_posts_nothing():
    desk, client = desk_with()
    first = desk.post("20260908-1600", "hello", "tok-1")
    second = desk.post("20260908-1600", "hello", "tok-1")
    assert second["duplicate"] is True and second["message_id"] == first["message_id"]
    assert len(client.sent) == 1
    # A new token is a new post.
    desk.post("20260908-1600", "hello", "tok-2")
    assert len(client.sent) == 2


def test_the_refusals_are_the_relay_s():
    desk, client = desk_with()
    # The id is one shape; anything else never becomes part of a topic name.
    assert "conversation id" in desk.post("../routine-ghtrends", "hi", "t")["error"]
    assert "conversation id" in desk.post("Upper", "hi", "t")["error"]
    assert "conversation id" in desk.post("", "hi", "t")["error"]
    assert "token" in desk.post("20260908-1600", "hi", "")["error"]
    assert "nothing to send" in desk.post("20260908-1600", "   ", "t")["error"]
    assert "machine-to-machine" in desk.post("20260908-1600", "[selfnote][rootchat] a/b", "t")["error"]
    desk.chat.max_chars = 10
    assert "over the 10" in desk.post("20260908-1600", "x" * 11, "t")["error"]
    assert client.sent == []
    unconfigured, _ = desk_with(configured=False)
    assert "AGENTROOM_CHAT_ZULIP_ENV" in unconfigured.post("20260908-1600", "hi", "t")["error"]


def test_a_failed_post_is_uncertain_never_retried_and_its_token_is_remembered():
    desk, client = desk_with(chat_client=RecordingClient(fail=ConnectionError("reset")))
    found = desk.post("20260908-1600", "hi", "tok-1")
    assert found["sent"] is False and found["uncertain"] is True
    assert "may have landed" in found["note"]
    again = desk.post("20260908-1600", "hi", "tok-1")
    assert again["duplicate"] is True and again["uncertain"] is True


def test_a_resolved_conversation_is_unresolved_in_place_before_the_post():
    held = topic(DESK, message("hi", ident=1), by_front("bye", ident=2), resolved=True)
    desk, client = desk_with(held)
    found = desk.post("20260908-1600", "one more thing", "tok-1")
    assert found["sent"] is True and found["resumed"] is True
    assert client.patched == [("PATCH", "messages/2", {
        "topic": DESK, "propagate_mode": "change_all", "send_notification_to_new_thread": False,
    })]
    assert client.sent == [("front", DESK, "one more thing")]


def test_resuming_a_resolved_conversation_finds_its_last_post_in_the_mirror():
    desk, client, ids = mirrored_desk((DEVELOPER, "Developer", "hi"), (FRONT_BOT, "Front", "bye"), resolved=True)
    found = desk.post("20260908-1600", "again", "tok-1")
    assert found["resumed"] is True and client.patched[0][1] == f"messages/{ids[-1]}"


# --- over HTTP, once ----------------------------------------------------------


def test_the_three_routes_answer_over_http(tmp_path):
    held = topic(DESK, message("hi", ident=1), by_front(ACK, ident=2), by_front("yo✨", ident=3))
    desk, client = desk_with(held)
    room = empty_room()
    server = build_server("127.0.0.1", 0, room, desk.ops, desk.chat, None, None, desk)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]

        def http(method, path, body=None):
            connection = HTTPConnection("127.0.0.1", port, timeout=5)
            connection.request(method, path, body=json.dumps(body) if body else None,
                               headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, json.loads(response.read())

        status, board = http("GET", "/frontdesk")
        assert status == 200 and [r["id"] for r in board["conversations"]] == ["20260908-1600"]
        status, found = http("GET", "/frontdesk/20260908-1600")
        assert status == 200 and found["conversation"]["latest_reply"]["content"] == "yo✨"
        status, refused = http("POST", "/frontdesk/20260908-1600/post", {"text": "hi", "token": ""})
        assert status == 403 and refused["sent"] is False
        status, sent = http("POST", "/frontdesk/20260908-1600/post", {"text": "hi", "token": "t1"})
        assert status == 200 and sent["sent"] is True and client.sent == [("front", DESK, "hi")]
        status, again = http("POST", "/frontdesk/20260908-1600/post", {"text": "hi", "token": "t1"})
        assert status == 200 and again["duplicate"] is True and len(client.sent) == 1
        status, bad = http("GET", "/frontdesk/..%2Fetc")
        assert status == 400
    finally:
        server.shutdown()
        server.server_close()


# --- the source and its memo (argue p2 step 3) --------------------------------


from agag.memo import fingerprint, render_record, source_note


def test_a_desk_conversation_carries_its_presentation_and_no_block_is_parsed():
    """The reply is shown as written — an old `ag-dialogue` block included —
    and the scene comes from the memo topic that names this conversation's
    first post."""
    desk, _, ids = mirrored_desk((DEVELOPER, "Developer", "how did it go?"), (FRONT_BOT, "Front", ACK),
                                 (FRONT_BOT, "Front", "@**Developer**\n\nDone: commit a99625f.\n\n```ag-dialogue\n{}\n```"))
    realm = desk.mirror.realm
    realm.add_channel(70, "memo")
    from conftest import pump

    realm.create_channel(70, "memo")
    realm.post("memo", f"{DESK}-s{ids[0]}", source_note(ids[0]), sender_id=FRONT_BOT, sender_name="Front")
    reply = realm.messages[ids[2]]["content"]
    realm.post("memo", f"{DESK}-s{ids[0]}", render_record({
        "schema": "ag.memo-dialogue.v1", "kind": "result", "job": "j1", "part": 1, "parts": 1,
        "source": {"anchor": ids[0], "channel": "front", "topic": DESK, "messages": [ids[2]],
                   "fingerprint": fingerprint([(ids[2], reply)])},
        "settings_revision": "aaaa1111", "renderer": "agfront.present/1",
        "turns": [{"character": "front", "speaker": "Front", "text": "できたよ🎉 a99625f",
                   "sources": [{"channel": "front", "topic": DESK, "message_id": ids[2]}]}]}),
        sender_id=FRONT_BOT, sender_name="Front")
    pump(desk.mirror)
    conversation = desk.conversation("20260908-1600", now=NOW)["conversation"]
    assert "```ag-dialogue" in conversation["latest_reply"]["content"]
    assert "dialogue" not in conversation["latest_reply"]
    shown = conversation["presentation"]
    assert shown["anchor"] == ids[0] and shown["memo"] == {"channel": "memo", "topic": f"{DESK}-s{ids[0]}"}
    (rendering,) = shown["renderings"][str(ids[2])]
    assert rendering["settings_revision"] == "aaaa1111" and not rendering["stale"]
    assert rendering["turns"][0]["text"] == "できたよ🎉 a99625f"
    assert [i["settings_revision"] for i in shown["interpretations"]] == ["aaaa1111"]


def test_asking_for_another_interpretation_is_one_selfnote_in_the_source_once():
    desk, client, ids = mirrored_desk((DEVELOPER, "Developer", "hello"), (FRONT_BOT, "Front", "hi"))
    found = desk.render("20260908-1600", "bbbb2222", "tok-r")
    assert found["sent"] and found["anchor"] == ids[0]
    assert client.sent == [("front", DESK, "[selfnote][render] bbbb2222")]
    assert desk.render("20260908-1600", "bbbb2222", "tok-r")["duplicate"] and len(client.sent) == 1
    assert "no settings revision" in desk.render("20260908-1600", None, "tok-s")["error"]
    assert "nothing of this conversation" in desk.render("20260101-0000", "bbbb2222", "tok-t")["error"]


# --- what a post is for, and what is still asked (clearer_chat_ui step 3) ---------------

PROGRESS = "Reading the project.\n\n`ag-post intent=progress`"
REPORT = "@**Developer**\n\nThe workplan is open.\n\n`ag-post intent=report`"


def asking(text, *, seen, ask="question"):
    return f"@**Developer**\n\n{text}\n\n`ag-post intent=response_request to=8 ask={ask} seen={seen}`"


def test_each_post_carries_its_meaning_and_the_line_is_never_shown():
    held = topic(DESK, message("build it", ident=1), by_front(ACK, ident=2), by_front(PROGRESS, ident=3),
                 by_front(asking("Which provider?", seen=2), ident=4))
    desk, _ = desk_with(held)
    posts = desk.conversation("20260908-1600", now=NOW)["conversation"]["posts"]
    assert [p["meaning"] for p in posts] == [
        None, None, {"intent": "progress"}, {"intent": "response_request", "to": 8, "ask": "question", "seen": 2}]
    assert all("ag-post" not in p["content"] for p in posts)
    assert posts[3]["content"] == "Which provider?"


def test_a_pending_question_makes_the_conversation_asking_and_is_listed():
    held = topic(DESK, message("build it", ident=1), by_front(ACK, ident=2),
                 by_front(asking("Which provider?", seen=2), ident=3),
                 by_front(asking("May I open a workplan?", seen=3, ask="confirmation"), ident=4))
    desk, _ = desk_with(held)
    conversation = desk.conversation("20260908-1600", now=NOW)["conversation"]
    assert conversation["status"]["state"] == "asking" and "#3, #4" in conversation["status"]["evidence"]
    assert conversation["requests"]["pending"] == [3, 4]
    assert conversation["viewer_id"] == DEVELOPER
    board = desk.board(now=NOW)["conversations"]
    assert board[0]["asking"] == 2 and board[0]["status"]["state"] == "asking"


def test_a_report_is_answered_and_asks_nothing():
    held = topic(DESK, message("build it", ident=1), by_front(ACK, ident=2), by_front(REPORT, ident=3))
    desk, _ = desk_with(held)
    conversation = desk.conversation("20260908-1600", now=NOW)["conversation"]
    assert conversation["status"]["state"] == "answered" and conversation["requests"]["pending"] == []


def test_replying_updates_the_wait_and_the_question_keeps_its_label():
    held = topic(DESK, message("build it", ident=1), by_front(ACK, ident=2),
                 by_front(asking("Which provider?", seen=2), ident=3), message("GitHub", ident=4))
    desk, _ = desk_with(held)
    conversation = desk.conversation("20260908-1600", now=NOW)["conversation"]
    assert conversation["requests"]["pending"] == []
    assert conversation["requests"]["requests"][0]["state"] == "answered"
    assert conversation["posts"][2]["meaning"]["intent"] == "response_request", "history keeps what it was"
    assert conversation["status"]["state"] == "waiting", "the Developer spoke last; Front has it now"


def test_a_question_asked_before_the_newer_post_was_read_is_not_a_wait():
    held = topic(DESK, message("build it", ident=1), by_front(ACK, ident=2), message("and fast", ident=3),
                 by_front(asking("Which provider?", seen=2), ident=4))
    desk, _ = desk_with(held)
    conversation = desk.conversation("20260908-1600", now=NOW)["conversation"]
    assert conversation["status"]["state"] == "received" and "owed a run first" in conversation["status"]["evidence"]
    assert conversation["requests"]["pending"] == []


def test_an_answer_names_the_request_inside_the_post():
    desk, client, ids = mirrored_desk(
        (DEVELOPER, "Developer", "build it"), (FRONT_BOT, "Front", asking("Which provider?", seen=1)),
        (FRONT_BOT, "Front", asking("May I open it?", seen=2, ask="confirmation")))
    found = desk.post("20260908-1600", "Yes.", "tok-a", [ids[2]])
    assert found["sent"] is True
    assert client.sent[-1] == ("front", DESK, f"Yes.\n\n`ag-post re={ids[2]}`")


def test_an_answer_to_something_that_is_not_a_request_here_is_refused():
    desk, client, ids = mirrored_desk((DEVELOPER, "Developer", "build it"),
                                      (FRONT_BOT, "Front", asking("Which provider?", seen=1)))
    found = desk.post("20260908-1600", "Yes.", "tok-b", [ids[0]])
    assert found["sent"] is False and "is not a request in this conversation" in found["error"]
    assert client.sent == []
    assert desk.post("20260908-1600", "Yes.", "tok-c", ["x"])["error"] == "answers must be message ids"
