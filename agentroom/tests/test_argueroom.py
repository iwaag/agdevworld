"""The Arguing Room door (`argue` p2 step 3), over a mirrored fake realm.

Pinned: an argue is its anchor (a rename is followed, a reused name is
another argue); creation and posts are the human's words once per token;
a resolved argue is resumed in place and keeps its history; the
presentation block relates every agent post to its saved interpretations,
with pending, failed, stale and an unavailable renderer said out loud; and
repeated reads cost no Zulip call.
"""

import json
import threading
from http.client import HTTPConnection

from agag.memo import fingerprint, render_record, source_note
from conftest import FakeRealm, empty_room, mirror_over, pump

from agentroom.argueroom import ArguingRoom
from agentroom.chat import Chat
from agentroom.server import build_server

NOW = 1_800_000_000.0
DEV, FRONT, AUTOLAB, SAGE = 8, 15, 11, 24
ACK = "Message received. Please wait for the reply."
REV_A, REV_B = "aaaa1111", "bbbb2222"


def roster(instance, agent, bot, bot_id):
    return (f"hello\n```agag-roster\nschema: ag.agent-roster.v1\ninstance: {instance}\nagent: {agent}\n"
            f"bot: {bot}\nbot_id: {bot_id}\nchannel: {instance}\nprefixes: x-\n```")


class Active:
    def __init__(self, revision=REV_A):
        self.revision = revision

    def active(self):
        return {"revision": self.revision} if self.revision else None


class Developer:
    """The chat credential, posting into the fake realm as the human."""

    def __init__(self, realm, fail=None):
        self.realm, self.fail, self.patched = realm, fail, []

    def whoami(self):
        return {"user_id": DEV, "full_name": "Developer"}

    def ensure_subscribed(self, channel):
        return True

    def topic_last_id(self, channel, topic):
        return max((i for i, m in self.realm.messages.items()
                    if m["display_recipient"] == channel and m["subject"] == topic), default=0)

    def send_to_channel(self, channel, topic, content):
        if self.fail:
            raise self.fail
        return self.realm.post(channel, topic, content, sender_id=DEV, sender_name="Developer")

    def resolve_topic(self, message_id, topic):
        self.realm.resolve("argue", topic)

    def stream_id(self, name):
        return next(row["stream_id"] for row in self.realm.channels_by_id.values() if row["name"] == name)

    def call(self, method, path, params=None):
        self.patched.append((method, path, params))
        ident = int(path.split("/")[1])
        old = self.realm.messages[ident]["subject"]
        ids = [i for i, m in self.realm.messages.items() if m["subject"] == old]
        self.realm.move(sorted(ids), params["topic"])
        return {}


def world(*, settings=None, fail=None):
    realm = FakeRealm()
    realm.base_url = "https://zulip.invalid"
    for stream_id, name in ((35, "agents"), (169, "argue"), (70, "memo")):
        realm.add_channel(stream_id, name)
    for instance, agent, bot, bot_id in (("front-x1", "front", "Front", FRONT), ("autolab-x1", "autolab", "autolab-x1", AUTOLAB),
                                         ("archsage-x1", "archsage", "archsage", SAGE)):
        realm.post("agents", f"intro-{instance}", roster(instance, agent, bot, bot_id), sender_id=bot_id,
                   sender_name=bot, quiet=True)
    mirror = mirror_over(realm)
    client = Developer(realm, fail)
    chat = Chat(env_path=__file__, client_factory=lambda path: client)
    return realm, mirror, client, ArguingRoom(mirror=mirror, chat=chat, settings=settings or Active())


def talk(realm, topic="argue-far", stamp=int(NOW - 120)):
    anchor = realm.post("argue", topic, "[selfnote][argue] from -", sender_id=DEV, sender_name="Developer", timestamp=stamp)
    human = realm.post("argue", topic, "I want machines that learn from failure.", sender_id=DEV, sender_name="Developer", timestamp=stamp)
    realm.post("argue", topic, ACK, sender_id=FRONT, sender_name="Front", timestamp=stamp)
    front = realm.post("argue", topic, "What would failure look like? I will ask autolab.", sender_id=FRONT, sender_name="Front", timestamp=stamp)
    built = realm.post("argue", topic, "I can build a harness.", sender_id=AUTOLAB, sender_name="autolab-x1", timestamp=stamp)
    sage = realm.post("argue", topic, "**[sage:arxiv]**\nThree papers bear on this.", sender_id=SAGE, sender_name="archsage", timestamp=stamp)
    return anchor, human, front, built, sage


def result(realm, anchor, topic, ids, revision, *, job, turns=None, content=None):
    current = content or {i: realm.messages[i]["content"] for i in ids}
    memo = f"{topic}-s{anchor}"
    if not any(m["subject"] == memo for m in realm.messages.values()):
        realm.post("memo", memo, source_note(anchor), sender_id=FRONT, sender_name="Front")
    return realm.post("memo", memo, render_record({
        "schema": "ag.memo-dialogue.v1", "kind": "result", "job": job, "part": 1, "parts": 1,
        "source": {"anchor": anchor, "channel": "argue", "topic": topic, "messages": ids,
                   "fingerprint": fingerprint((i, current[i]) for i in ids)},
        "settings_revision": revision, "renderer": "agfront.present/1",
        "turns": turns or [{"character": "front", "speaker": "Front", "text": f"voiced {i} at {revision}",
                            "sources": [{"channel": "argue", "topic": topic, "message_id": i}]} for i in ids]}),
        sender_id=FRONT, sender_name="Front")


# --- reading ----------------------------------------------------------------------


def test_the_list_and_one_argue_show_every_participant_and_never_a_note():
    realm, mirror, _, room = world()
    anchor, human, front, built, sage = talk(realm)
    realm.post("argue", "argue-far", f"[selfnote][desire] {human} by {DEV}", sender_id=FRONT, sender_name="Front")
    pump(mirror)
    (row,) = room.board(now=NOW)["argues"]
    assert row["anchor"] == anchor and row["stem"] == "far" and row["posts"] == 4 and not row["resolved"]
    assert row["speakers"] == ["Developer", "Front", "autolab-x1", "sage:arxiv"]
    assert row["desire"] == {"message_id": human, "user_id": DEV} and row["status"]["state"] == "answered"
    argue = room.argue(anchor, now=NOW)["argue"]
    assert [(p["message_id"], p["kind"], p["speaker"], p["agent"]) for p in argue["posts"]] == [
        (human, "human", "Developer", None), (human + 1, "ack", "Front", "front"), (front, "agent", "Front", "front"),
        (built, "agent", "autolab-x1", "autolab"), (sage, "agent", "sage:arxiv", "archsage")]
    assert argue["posts"][-1]["content"] == "Three papers bear on this." and argue["posts"][-1]["logical"] == "sage:arxiv"
    assert "selfnote" not in json.dumps(argue["posts"])
    assert argue["zulip_url"].startswith("https://zulip.invalid/#narrow/channel/169-argue/topic/argue-far")


def test_an_argue_is_followed_by_its_anchor_through_a_rename_and_a_reused_name_is_another_argue():
    realm, mirror, _, room = world()
    anchor, *_ = talk(realm)
    pump(mirror)
    realm.move(sorted(i for i, m in realm.messages.items() if m["subject"] == "argue-far"), "argue-renamed")
    other = realm.post("argue", "argue-far", "[selfnote][argue] from -", sender_id=DEV, sender_name="Developer")
    realm.post("argue", "argue-far", "A different desire under the freed name.", sender_id=DEV, sender_name="Developer")
    pump(mirror)
    assert room.argue(anchor, now=NOW)["argue"]["topic"] == "argue-renamed"
    assert len(room.argue(anchor, now=NOW)["argue"]["posts"]) == 5
    assert room.argue(other, now=NOW)["argue"]["topic"] == "argue-far"
    assert len(room.argue(other, now=NOW)["argue"]["posts"]) == 1
    assert {r["anchor"] for r in room.board(now=NOW)["argues"]} == {anchor, other}
    assert "not the anchor note" in room.argue(anchor + 1)["error"]
    assert "not in the realm" in room.argue(999999)["error"] and "not an argue anchor" in room.argue("far")["error"]


def test_repeated_reads_cost_no_zulip_call():
    realm, mirror, _, room = world()
    anchor, *_ = talk(realm)
    result(realm, anchor, "argue-far", [anchor + 3], REV_A, job="j1")
    pump(mirror)
    before = mirror.health()["calls"]
    for _ in range(5):
        room.board(now=NOW)
        room.argue(anchor, now=NOW)
    assert mirror.health()["calls"] == before


# --- the presentation ------------------------------------------------------------------


def test_every_agent_post_is_related_to_its_interpretations_with_status():
    realm, mirror, _, room = world()
    anchor, human, front, built, sage = talk(realm)
    result(realm, anchor, "argue-far", [front, built], REV_A, job="ja", turns=[
        {"character": "front", "speaker": "Front", "text": "F1", "sources": [{"channel": "argue", "topic": "argue-far", "message_id": front}]},
        {"character": "front", "speaker": "Front", "text": "F2", "sources": [{"channel": "argue", "topic": "argue-far", "message_id": front}]},
        {"character": "autolab", "speaker": "autolab-x1", "text": "A1", "sources": [{"channel": "argue", "topic": "argue-far", "message_id": built}]}])
    result(realm, anchor, "argue-far", [front], REV_B, job="jb")
    pump(mirror)
    shown = room.argue(anchor, now=NOW)["argue"]["presentation"]
    assert shown["memo"] == {"channel": "memo", "topic": f"argue-far-s{anchor}"} and shown["active_revision"] == REV_A
    assert [(i["settings_revision"], i["results"], i["posts"]) for i in shown["interpretations"]] in (
        [(REV_B, 1, 1), (REV_A, 1, 2)], [(REV_A, 1, 2), (REV_B, 1, 1)])
    assert [r["settings_revision"] for r in shown["renderings"][str(front)]] == [REV_A, REV_B]
    assert [t["text"] for t in shown["renderings"][str(front)][0]["turns"]] == ["F1", "F2"]
    assert shown["renderings"][str(built)][0]["turns"][0]["sources"][0]["message_id"] == built
    # The sage's post has no result at the active revision: pending, and young.
    assert [(p["message_id"], p["overdue"]) for p in shown["pending"]] == [(sage, False)]
    assert shown["renderer"]["state"] == "rendering" and str(human) not in shown["renderings"]


def test_a_failed_job_an_unavailable_renderer_and_a_stale_result_are_said():
    realm, mirror, _, room = world()
    anchor, human, front, built, sage = talk(realm, stamp=int(NOW - 3600))
    result(realm, anchor, "argue-far", [front], REV_A, job="ja")
    realm.post("memo", f"argue-far-s{anchor}", render_record({
        "schema": "ag.memo-dialogue.v1", "kind": "failed", "job": "jf", "attempts": 3, "error": "the model is unavailable",
        "source": {"anchor": anchor, "channel": "argue", "topic": "argue-far", "messages": [built], "fingerprint": "x"},
        "settings_revision": REV_A, "renderer": "agfront.present/1"}), sender_id=FRONT, sender_name="Front")
    realm.edit(front, "What would failure look like? (edited)")
    pump(mirror)
    shown = room.argue(anchor, now=NOW)["argue"]["presentation"]
    assert shown["renderings"][str(front)][0]["stale"] is True
    assert shown["failed"][0]["messages"] == [built] and "unavailable" in shown["failed"][0]["error"]
    # Stale and never rendered are both waiting at the active revision; failed is not.
    assert sorted(p["message_id"] for p in shown["pending"]) == [front, sage]
    assert all(p["overdue"] for p in shown["pending"]) and shown["renderer"]["state"] == "unavailable"
    # With no active settings nothing can be pending, and the history is still there.
    room.settings = Active(None)
    found = room.argue(anchor, now=NOW)["argue"]
    assert found["presentation"]["pending"] == [] and found["presentation"]["renderer"]["state"] == "unknown"
    assert len(found["posts"]) == 5 and found["presentation"]["renderings"][str(front)]


def test_a_stale_mirror_marks_the_state_and_keeps_the_history():
    realm, mirror, _, room = world()
    anchor, *_ = talk(realm)
    pump(mirror)
    mirror._set_stale("the event queue is not answering")
    found = room.argue(anchor, now=NOW)
    assert found["health"]["state"] != "live" and found["argue"]["status"]["state"] == "unknown"
    assert found["argue"]["stale_state"] == "answered" and len(found["argue"]["posts"]) == 5


# --- writing ------------------------------------------------------------------------------


def test_creating_an_argue_is_the_anchor_note_then_the_humans_words_once():
    realm, mirror, _, room = world()
    found = room.create("Aquarium Dreams", "x", "tok-0")
    assert not found["sent"] and "not a usable name" in found["error"]
    found = room.create("aquarium", "I want a self-cleaning aquarium.", "tok-1", now=NOW)
    assert found["sent"] and found["topic"] == "argue-aquarium"
    again = room.create("aquarium", "I want a self-cleaning aquarium.", "tok-1", now=NOW)
    assert again["duplicate"] and again["anchor"] == found["anchor"]
    rows = sorted((m for m in realm.messages.values() if m["display_recipient"] == "argue"), key=lambda m: m["id"])
    assert [(m["sender_id"], m["content"]) for m in rows] == [
        (DEV, "[selfnote][argue] from -"), (DEV, "I want a self-cleaning aquarium.")]
    pump(mirror)
    assert room.argue(found["anchor"], now=NOW)["argue"]["posts"][0]["content"] == "I want a self-cleaning aquarium."
    # The name is taken now, for a different submit too.
    assert "already exists" in room.create("aquarium", "another", "tok-2")["error"]
    minted = room.create(None, "no name given", "tok-3", now=NOW)
    assert minted["sent"] and minted["topic"].startswith("argue-20")


def test_a_post_goes_into_the_source_once_and_the_refusals_are_the_relays():
    realm, mirror, _, room = world()
    anchor, *_ = talk(realm)
    pump(mirror)
    found = room.post(anchor, "  Failure means a wrong answer nobody notices.  ", "tok-1")
    assert found["sent"] and not found["resumed"]
    assert realm.messages[found["message_id"]]["content"] == "Failure means a wrong answer nobody notices."
    assert realm.messages[found["message_id"]]["subject"] == "argue-far"
    assert room.post(anchor, "Failure means a wrong answer nobody notices.", "tok-1")["duplicate"]
    assert sum(1 for m in realm.messages.values() if "nobody notices" in m["content"]) == 1
    assert "submit token" in room.post(anchor, "text", "")["error"]
    assert "selfnote" in room.post(anchor, "[selfnote][desire] 1 by 8", "tok-2")["error"]
    assert "nothing to send" in room.post(anchor, "   ", "tok-3")["error"]
    assert "not in the realm" in room.post(424242, "text", "tok-4")["error"]


def test_a_failed_post_is_uncertain_and_never_retried():
    realm, mirror, client, room = world(fail=RuntimeError("timed out"))
    client.fail = None
    anchor, *_ = talk(realm)
    pump(mirror)
    client.fail = RuntimeError("timed out")
    found = room.post(anchor, "did this land?", "tok-1")
    assert not found["sent"] and found["uncertain"] and "check #argue" in found["note"]
    client.fail = None
    assert room.post(anchor, "did this land?", "tok-1")["duplicate"]


def test_a_resolved_argue_keeps_its_history_and_is_resumed_in_place():
    realm, mirror, client, room = world()
    anchor, *_ = talk(realm)
    realm.post("argue", "argue-far", "[selfnote][outcome] project pj-failfarm", sender_id=FRONT, sender_name="Front")
    realm.resolve("argue", "argue-far")
    pump(mirror)
    argue = room.argue(anchor, now=NOW)["argue"]
    assert argue["resolved"] and argue["live_topic"] == "✔ argue-far" and argue["status"]["state"] == "done"
    assert len(argue["posts"]) == 5 and argue["outcome"] == "project pj-failfarm"
    found = room.post(anchor, "One more thought.", "tok-1")
    assert found["sent"] and found["resumed"] and "stays as it is" in found["note"]
    assert client.patched[0][2]["topic"] == "argue-far"
    pump(mirror)
    argue = room.argue(anchor, now=NOW)["argue"]
    assert not argue["resolved"] and argue["posts"][-1]["content"] == "One more thought." and len(argue["posts"]) == 6
    # Nothing but the argue was touched: one rename, one post, both in #argue.
    assert all(m["display_recipient"] in ("argue", "agents") for m in realm.messages.values())


def test_a_reinterpretation_request_is_one_selfnote_in_the_source_and_is_visible_until_answered():
    realm, mirror, _, room = world()
    anchor, *_ = talk(realm)
    realm.resolve("argue", "argue-far")
    pump(mirror)
    found = room.render(anchor, REV_B, "tok-1")
    assert found["sent"] and found["settings_revision"] == REV_B
    note = realm.messages[found["message_id"]]
    assert note["content"] == f"[selfnote][render] {REV_B}" and note["subject"] == "✔ argue-far"
    assert room.render(anchor, REV_B, "tok-1")["duplicate"]
    assert room.render(anchor, None, "tok-2")["settings_revision"] == REV_A  # defaults to the active one
    assert "no settings revision" in room.render(anchor, "not-a-sha", "tok-3")["error"]
    pump(mirror)
    argue = room.argue(anchor, now=NOW)["argue"]
    assert argue["resolved"], "asking for an interpretation does not reopen the discussion"
    assert [r["settings_revision"] for r in argue["presentation"]["requests"]] == [REV_B, REV_A]


# --- over HTTP, once -------------------------------------------------------------------------


def test_the_routes_answer_over_http():
    realm, mirror, _, room = world()
    anchor, *_ = talk(realm)
    pump(mirror)
    server = build_server("127.0.0.1", 0, empty_room(), argues=room)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        def call(method, path, body=None):
            connection = HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            connection.request(method, path, body=json.dumps(body) if body is not None else None,
                               headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, json.loads(response.read())

        assert call("GET", "/argues")[1]["argues"][0]["anchor"] == anchor
        assert call("GET", f"/argues/{anchor}")[1]["argue"]["topic"] == "argue-far"
        assert call("GET", "/argues/424242")[0] == 404
        status, found = call("POST", f"/argues/{anchor}/post", {"text": "over http", "token": "h1"})
        assert status == 200 and found["sent"]
        assert call("POST", f"/argues/{anchor}/post", {"text": "over http"})[0] == 403
        status, found = call("POST", "/argues", {"stem": "http-made", "text": "a new desire", "token": "h2"})
        assert status == 200 and found["topic"] == "argue-http-made"
        assert call("POST", f"/argues/{anchor}/render", {"token": "h3"})[1]["settings_revision"] == REV_A
        assert "/argues/<anchor>/post" in call("GET", "/")[1]["post"]
    finally:
        server.shutdown()
        server.server_close()


def test_closing_an_argue_from_the_room_is_the_shared_door_keyed_by_anchor():
    """`argue` p2 ex1: the preview and the close are reached by anchor, the
    plan names the argue's *current* topic and nothing else, the close is a
    ✔ with no note written, and a post afterwards resumes it."""
    from agentroom.close import Closer
    from agentroom.realm import MirrorRealm

    realm, mirror, client, room = world()
    anchor, *_ = talk(realm)
    pump(mirror)
    realm.move(sorted(i for i, m in realm.messages.items() if m["subject"] == "argue-far"), "argue-renamed")
    pump(mirror)
    mirror.start()
    door = Closer(topics=lambda: {}, reader_factory=lambda: MirrorRealm(mirror), writer_factory=lambda: client,
                  mirror=mirror, confirm_seconds=2.0)
    server = build_server("127.0.0.1", 0, empty_room(), closer=door, argues=room)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        def call(method, path, body=None):
            connection = HTTPConnection("127.0.0.1", server.server_address[1], timeout=10)
            connection.request(method, path, body=json.dumps(body) if body is not None else None,
                               headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            return response.status, json.loads(response.read())

        status, plan = call("GET", f"/argues/{anchor}/close-plan")
        assert status == 200 and plan["scope"]["kind"] == "argue" and plan["topic"] == "argue-renamed"
        assert [a["key"] for a in plan["actions"]] == ["topic:argue/argue-renamed"]
        assert plan["actions"][0]["state"] == "ready"
        assert call("GET", "/argues/424242/close-plan")[0] == 400
        before = len(realm.messages)
        status, done = call("POST", f"/argues/{anchor}/close", {"fingerprint": plan["fingerprint"]})
        assert status == 200 and done["applied"] and not done["partial"]
        assert done["results"][0]["outcome"] == "applied"
        assert len(realm.messages) == before, "a human close writes no note"
        assert realm.messages[anchor]["subject"] == "✔ argue-renamed"
        status, again = call("GET", f"/argues/{anchor}/close-plan")
        assert again["actions"][0]["state"] == "done" and again["actions"][0]["reason"] == "already ✔"
        assert call("POST", f"/argues/{anchor}/close", {"fingerprint": "stale"})[0] == 409
        # And the room's own post resumes it, as before.
        status, found = call("POST", f"/argues/{anchor}/post", {"text": "one more thought", "token": "c1"})
        assert status == 200 and found["resumed"]
        assert "/argues/<anchor>/close" in call("GET", "/")[1]["post"]
    finally:
        server.shutdown()
        server.server_close()
        mirror.stop()


def test_the_reader_joins_new_public_channels_and_re_reads_what_it_missed():
    """A resolve is a move, and moves reach only subscribers (met live)."""
    from agentroom.subscriptions import ensure_subscribed

    realm, mirror, _, room = world()

    class Reader:
        def __init__(self):
            self.joined, self.asked = {"agents"}, []

        def subscriptions(self):
            return [{"name": name} for name in self.joined]

        def subscribe_channels(self, names):
            self.asked.append(list(names))
            self.joined.update(names)

    reader, lines, resyncs = Reader(), [], []
    mirror.resync = lambda: resyncs.append(1)
    assert ensure_subscribed(reader, mirror, lines.append) == ["argue", "memo"]
    assert reader.asked == [["argue", "memo"]] and resyncs == [1] and "#argue" in lines[0]
    assert ensure_subscribed(reader, mirror, lines.append) == [] and resyncs == [1]


# --- what a post is for, and what is still asked (clearer_chat_ui step 4) ---------------


def test_an_argue_carries_meanings_and_two_speakers_questions_to_the_human():
    realm, mirror, _, room = world()
    anchor, *_ = talk(realm)
    ask_front = realm.post("argue", "argue-far", "Which failure matters most?\n\n`ag-post intent=response_request to=8 ask=question`",
                           sender_id=FRONT, sender_name="Front")
    ask_lab = realm.post("argue", "argue-far", "May I prototype it?\n\n`ag-post intent=response_request to=8 ask=confirmation`",
                         sender_id=AUTOLAB, sender_name="autolab-x1")
    realm.post("argue", "argue-far", "**[sage:arxiv]**\nOne more paper.\n\n`ag-post intent=report`", sender_id=SAGE, sender_name="archsage")
    pump(mirror)
    argue = room.argue(anchor)["argue"]
    assert argue["status"]["state"] == "asking" and argue["asking"] == 2
    assert argue["requests"]["pending"] == [ask_front, ask_lab] and argue["viewer_id"] == DEV
    meanings = {p["message_id"]: p["meaning"] for p in argue["posts"]}
    assert meanings[ask_lab] == {"intent": "response_request", "to": DEV, "ask": "confirmation"}
    assert all("ag-post" not in p["content"] for p in argue["posts"])
    # The human answers autolab's by name: only that one settles.
    sent = room.post(anchor, "Yes, prototype it.", "tok-ans", [ask_lab])
    assert sent["sent"] and realm.messages[sent["message_id"]]["content"].endswith(f"`ag-post re={ask_lab}`")
    pump(mirror)
    after = room.argue(anchor)["argue"]["requests"]
    assert after["pending"] == [ask_front]
    assert "not a request" in room.post(anchor, "x", "tok-bad", [anchor])["error"]
