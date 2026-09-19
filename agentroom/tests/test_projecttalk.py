"""Talking in a project's conversations (`project_room` p1 step 2), with a
mocked poster.

Pinned: a mission or task is read by its anchor with the destination and the
responsible agent labelled; a plan comment lands in the planning conversation
and a run comment in the execution one; the destination follows a rename and
never a reused name; a document is refused with the path to Front; a ✔'d
target needs an explicit resume and says it resumed; a repeated token is one
post; a failed send is uncertain and never retried; a deleted anchor sends
nothing; every read costs no Zulip call.
"""

import json
import threading
from http.client import HTTPConnection

from conftest import mirror_over, pump

from agentroom.chat import Chat
from agentroom.ops import Ops
from agentroom.projectroom import ProjectRoom
from agentroom.projecttalk import EXECUTION, NONE, PLANNING, ProjectTalk
from agentroom.room import Room
from agentroom.server import build_server
from test_projectroom import ACK, AUTOLAB, DEV, FRONT, NOW, bot, dev, front, mission, open_project, world


class Developer:
    """The chat credential, posting into the fake realm as the human."""

    def __init__(self, realm, fail=None):
        self.realm, self.fail, self.patched, self.sent = realm, fail, [], []

    def whoami(self):
        return {"user_id": DEV, "full_name": "Developer"}

    def send_to_channel(self, channel, topic, content):
        if self.fail:
            raise self.fail
        self.sent.append((channel, topic, content))
        return self.realm.post(channel, topic, content, sender_id=DEV, sender_name="Developer", timestamp=int(NOW))

    def call(self, method, path, params=None):
        self.patched.append((method, path, params))
        ident = int(path.split("/")[1])
        old = self.realm.messages[ident]["subject"]
        ids = [i for i, m in self.realm.messages.items() if m["subject"] == old]
        self.realm.move(sorted(ids), params["topic"])
        return {}


def talk_over(realm, *, fail=None, chat_configured=True):
    mirror = mirror_over(realm)
    ops = Ops(mirror=mirror, stalled_seconds=900.0, done_seconds=1e12)
    room = ProjectRoom(mirror=mirror, ops=ops)
    client = Developer(realm, fail)
    chat = Chat(env_path=__file__ if chat_configured else None, client_factory=lambda path: client)
    return mirror, client, ProjectTalk(room=room, chat=chat)


def project_with_work(realm):
    realm.add_channel(93, "pj-media", folder_id=6, description="[AUTO] project: media; study; opened from argue argue/argue-media")
    realm.post("argue", "argue-media", "[selfnote][argue] from -", sender_id=DEV, sender_name="Developer", timestamp=int(NOW - 9000))
    front(realm, "pj-media", "researchplan-media", "# Media plan\n\nStudy it.", at=NOW - 8000)
    anchor, doc, tasks = mission(realm, "pj-media", "workplan-one", "media", tasks=2, work_stream=200, at=NOW - 3000)
    dev(realm, f"work-m{anchor}", f"workrun-task1-m{anchor}", "Start task 1.", at=NOW - 2000)
    bot(realm, f"work-m{anchor}", f"workrun-task1-m{anchor}", ACK, at=NOW - 1990)
    bot(realm, f"work-m{anchor}", f"workrun-task1-m{anchor}", "@**Developer**\n\nTask 1 done: https://git.invalid/autodev/media.git", at=NOW - 1900)
    return anchor, doc, tasks


# --- reads --------------------------------------------------------------------------


def test_a_mission_and_a_task_are_read_by_anchor_with_their_destination_and_agent_labelled():
    realm = world()
    anchor, doc, tasks = project_with_work(realm)
    mirror, client, talk = talk_over(realm)
    plan = talk.work(anchor, now=NOW)
    conv = plan["conversation"]
    assert plan["schema"] == "ag.projecttalk.v1" and conv["kind"] == "mission" and conv["anchor"] == anchor
    assert conv["project"]["channel"] == "pj-media" and conv["project"]["origin"]["anchor"] is not None
    assert conv["destination"]["role"] == PLANNING and conv["destination"]["postable"]
    assert conv["destination"]["responsible"] == [{"instance": "autolab-x1", "agent": "autolab", "bot": "autolab-x1", "bot_id": AUTOLAB}]
    assert conv["destination"]["label"] == "#pj-media › workplan-one — the planning conversation, answered by autolab-x1"
    assert [p["kind"] for p in conv["posts"]] == ["human", "ack", "agent", "agent"]
    assert "selfnote" not in json.dumps(conv["posts"]) and conv["status"]["state"] == "answered"
    assert conv["record"]["label"] == f"m{anchor}" and conv["record"]["task_counts"]["total"] == 2
    assert conv["record"]["document"]["content"].startswith("# Plan for workplan-one")
    assert conv["zulip_url"] == "https://zulip.invalid/#narrow/channel/93-pj-media/topic/workplan-one"
    assert conv["front"] is None and "buys a run" in conv["note"]
    run = talk.work(tasks[0], now=NOW)["conversation"]
    assert run["kind"] == "task" and run["destination"]["role"] == EXECUTION
    assert run["destination"]["channel"] == f"work-m{anchor}" and run["destination"]["topic"] == f"workrun-task1-m{anchor}"
    assert run["record"]["serial"] == 1 and run["record"]["links"][0]["kind"] == "repository"
    assert [p["kind"] for p in run["posts"]] == ["agent", "human", "ack", "agent"]
    assert "no mission or task" in talk.work(999)["error"] and "no mission or task" in talk.work("x")["error"]
    before = realm.calls
    for _ in range(3):
        talk.work(anchor, now=NOW)
        talk.work(tasks[1], now=NOW)
    assert realm.calls == before


def test_a_document_is_read_with_the_path_to_front_and_a_setup_is_a_planning_conversation():
    realm = world()
    open_project(realm, 170, "garden", "project", folder=19, argue="argue-garden")
    dev(realm, "pj-garden", "workplan-loose", "Mission: an old-style ask nobody recorded", at=NOW - 1000)
    mirror, client, talk = talk_over(realm)
    doc = talk.topic("pj-garden", "goal", now=NOW)["conversation"]
    assert doc["kind"] == "document" and doc["destination"]["role"] == NONE and not doc["destination"]["postable"]
    assert doc["destination"]["label"].endswith("a document topic, which nobody serves")
    assert doc["front"]["desk"] == "/?view=frontdesk" and doc["front"]["argue"].startswith("/?view=argue&argue=")
    assert doc["posts"][0]["content"].startswith("# Garden goal") and doc["anchor"] is None
    setup = talk.topic("170", "workplan-setup-garden", now=NOW)["conversation"]
    assert setup["kind"] == "setup" and setup["destination"]["role"] == PLANNING
    assert setup["destination"]["responsible"][0]["instance"] == "autolab-x1" and setup["status"]["state"] == "waiting"
    loose = talk.topic("garden", "workplan-loose", now=NOW)["conversation"]
    assert loose["kind"] == "plan" and loose["destination"]["postable"]
    assert "no conversation named" in talk.topic("pj-garden", "nothing")["error"]
    assert "no project channel" in talk.topic("pj-none", "goal")["error"]


def test_a_recorded_conversation_is_not_read_by_name():
    realm = world()
    anchor, *_ = project_with_work(realm)
    mirror, client, talk = talk_over(realm)
    found = talk.topic("pj-media", "workplan-one", now=NOW)
    assert found["anchor"] == anchor and "read it as /work/" in found["error"]
    refused = talk.post_topic("pj-media", "workplan-one", "hi", "t1")
    assert not refused["sent"] and refused["anchor"] == anchor and client.sent == []


# --- writes ---------------------------------------------------------------------------


def test_a_plan_comment_lands_in_the_planning_conversation_and_a_run_comment_in_the_execution_one():
    realm = world()
    anchor, doc, tasks = project_with_work(realm)
    mirror, client, talk = talk_over(realm)
    found = talk.post_work(anchor, "Please add a third task.", "t1")
    assert found["sent"] and found["role"] == PLANNING and found["resumed"] is False
    assert client.sent == [("pj-media", "workplan-one", "Please add a third task.")]
    found = talk.post_work(tasks[1], "  Start task 2.  ", "t2")
    assert found["sent"] and found["role"] == EXECUTION
    assert client.sent[-1] == (f"work-m{anchor}", f"workrun-task2-m{anchor}", "Start task 2.")
    pump(mirror)
    posts = talk.work(tasks[1], now=NOW)["conversation"]["posts"]
    assert posts[-1]["content"] == "Start task 2." and posts[-1]["kind"] == "human"
    # Comments into an unrecorded plan and a setup go into those conversations.
    realm.create_channel(170, "pj-garden", folder_id=19, description="[AUTO] project: garden; project; opened from argue argue/argue-garden")
    front(realm, "pj-garden", "workplan-setup-garden", "Please prepare the workspace.", at=NOW - 50)
    pump(mirror)
    found = talk.post_topic("pj-garden", "workplan-setup-garden", "How is it going?", "t3")
    assert found["sent"] and client.sent[-1] == ("pj-garden", "workplan-setup-garden", "How is it going?")


def test_the_destination_follows_a_rename_and_never_a_reused_name():
    realm = world()
    anchor, doc, tasks = project_with_work(realm)
    mirror, client, talk = talk_over(realm)
    ids = sorted(i for i, m in realm.messages.items() if m["subject"] == "workplan-one")
    realm.move(ids, "✔ retired-workplan-one-m" + str(anchor))
    # Somebody else takes the freed name with a new mission.
    other, *_ = mission(realm, "pj-media", "workplan-one", "media", tasks=0, at=NOW - 500)
    pump(mirror)
    read = talk.work(anchor, now=NOW)["conversation"]
    assert read["destination"]["topic"] == f"retired-workplan-one-m{anchor}" and read["destination"]["resolved"]
    assert talk.work(other, now=NOW)["conversation"]["destination"]["topic"] == "workplan-one"
    # A comment on the new mission lands under the name; one on the old is refused (✔) and never lands under the reused name.
    found = talk.post_work(other, "A comment on the new plan.", "t1")
    assert found["sent"] and client.sent == [("pj-media", "workplan-one", "A comment on the new plan.")]
    refused = talk.post_work(anchor, "A comment on the old plan.", "t2")
    assert not refused["sent"] and refused["needs_resume"] and refused["resolved"] and len(client.sent) == 1
    # Resumed on purpose: the old conversation is un-resolved under its own name and the comment goes there.
    resumed = talk.post_work(anchor, "A comment on the old plan.", "t3", resume=True)
    assert resumed["sent"] and resumed["resumed"] and resumed["topic"] == f"retired-workplan-one-m{anchor}"
    assert client.sent[-1][1] == f"retired-workplan-one-m{anchor}"
    assert client.patched[0][2]["topic"] == f"retired-workplan-one-m{anchor}"
    # A plain rename (no ✔) is followed without a resume.
    task_ids = sorted(i for i, m in realm.messages.items() if m["subject"] == f"workrun-task2-m{anchor}")
    realm.move(task_ids, "workrun-task2-renamed")
    pump(mirror)
    found = talk.post_work(tasks[1], "Run comment.", "t4")
    assert found["sent"] and found["topic"] == "workrun-task2-renamed" and not found["resumed"]


def test_a_document_is_refused_with_the_path_to_front_and_a_stranger_topic_too():
    realm = world()
    open_project(realm, 170, "garden", "project", folder=19, argue="argue-garden")
    dev(realm, "pj-garden", "notes", "just notes", at=NOW - 100)
    mirror, client, talk = talk_over(realm)
    refused = talk.post_topic("pj-garden", "goal", "Change the goal.", "t1")
    assert not refused["sent"] and refused["kind"] == "document" and "dispatch nothing" in refused["error"]
    assert refused["front"]["desk"] == "/?view=frontdesk" and refused["front"]["argue"].startswith("/?view=argue&argue=")
    assert client.sent == []
    other = talk.post_topic("pj-garden", "notes", "hello", "t2")
    assert not other["sent"] and other["kind"] == "other" and client.sent == []
    assert "nothing was sent" in talk.post_topic("pj-garden", "gone", "x", "t3")["error"]
    assert "no project channel" in talk.post_topic("pj-none", "goal", "x", "t4")["error"]


def test_a_repeated_token_is_one_post_and_a_failed_send_is_uncertain_and_never_retried():
    realm = world()
    anchor, doc, tasks = project_with_work(realm)
    mirror, client, talk = talk_over(realm)
    first = talk.post_work(anchor, "Once.", "same")
    again = talk.post_work(anchor, "Once.", "same")
    assert first["sent"] and again["duplicate"] and again["message_id"] == first["message_id"]
    assert client.sent == [("pj-media", "workplan-one", "Once.")]
    client.fail = RuntimeError("timed out")
    failed = talk.post_work(tasks[0], "Twice?", "t2")
    assert not failed["sent"] and failed["uncertain"] and "timed out" in failed["error"]
    assert "before sending again" in failed["note"] and failed["topic"] == f"workrun-task1-m{anchor}"
    repeated = talk.post_work(tasks[0], "Twice?", "t2")
    assert repeated["duplicate"] and repeated["uncertain"] and len(client.sent) == 1
    client.fail = None
    # The refusals that cost nothing: no token, empty text, a selfnote, over-long, unconfigured chat.
    assert "submit token" in talk.post_work(anchor, "x", "")["error"]
    assert talk.post_work(anchor, "   ", "t5")["error"] == "nothing to send"
    assert "machine-to-machine" in talk.post_work(anchor, "[selfnote][state] done", "t6")["error"]
    assert "over the" in talk.post_work(anchor, "x" * 5000, "t7")["error"]
    _, _, quiet = talk_over(realm, chat_configured=False)
    assert "unset" in quiet.post_work(anchor, "x", "t8")["error"] and quiet.work(anchor, now=NOW)["chat"]["configured"] is False


def test_a_deleted_anchor_sends_nothing_and_a_resolved_task_is_resumed_on_purpose_only():
    realm = world()
    anchor, doc, tasks = project_with_work(realm)
    realm.resolve(f"work-m{anchor}", f"workrun-task1-m{anchor}")
    mirror, client, talk = talk_over(realm)
    refused = talk.post_work(tasks[0], "Reopen?", "t1")
    assert refused["needs_resume"] and "carries ✔" in refused["error"] and client.sent == []
    resumed = talk.post_work(tasks[0], "Reopen.", "t2", resume=True)
    assert resumed["sent"] and resumed["resumed"] and client.patched and resumed["topic"] == f"workrun-task1-m{anchor}"
    pump(mirror)
    assert talk.work(tasks[0], now=NOW)["conversation"]["destination"]["resolved"] is False
    # The record is deleted from the realm: absent, nothing sent, and the read says so.
    realm.delete(tasks[1])
    pump(mirror)
    gone = talk.post_work(tasks[1], "Hello?", "t3")
    assert not gone["sent"] and "no mission or task" in gone["error"] and len(client.sent) == 1
    assert "no mission or task" in talk.work(tasks[1], now=NOW)["error"]


def test_a_stale_mirror_marks_the_status_unknown_and_the_history_is_still_returned():
    realm = world()
    anchor, *_ = project_with_work(realm)
    mirror, client, talk = talk_over(realm)
    mirror._set_stale("event queue expired; resyncing")
    found = talk.work(anchor, now=NOW)["conversation"]
    assert found["status"]["state"] == "unknown" and found["status"]["stale_state"] == "answered" and len(found["posts"]) == 4


def test_the_routes_read_and_write_and_answer_409_for_a_resume_and_403_for_a_document():
    realm = world()
    anchor, doc, tasks = project_with_work(realm)
    realm.resolve(f"work-m{anchor}", f"workrun-task2-m{anchor}")
    mirror, client, talk = talk_over(realm)
    server = build_server("127.0.0.1", 0, Room(mirror=mirror), projects=talk.room, talk=talk)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def call(method, path, body=None):
        connection = HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
        connection.request(method, path, body=json.dumps(body) if body is not None else None,
                           headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        return response.status, json.loads(response.read())

    try:
        status, found = call("GET", f"/work/{anchor}")
        assert status == 200 and found["conversation"]["destination"]["role"] == PLANNING
        status, found = call("GET", "/projects/pj-media/topics/researchplan-media")
        assert status == 200 and found["conversation"]["kind"] == "document"
        assert call("GET", "/work/12345")[0] == 404
        status, found = call("POST", f"/work/{anchor}/post", {"text": "Plan comment", "token": "a"})
        assert status == 200 and found["sent"] and client.sent[-1][1] == "workplan-one"
        status, found = call("POST", f"/work/{tasks[1]}/post", {"text": "Run comment", "token": "b"})
        assert status == 409 and found["needs_resume"]
        status, found = call("POST", f"/work/{tasks[1]}/post", {"text": "Run comment", "token": "b", "resume": True})
        assert status == 200 and found["resumed"]
        status, found = call("POST", "/projects/pj-media/topics/researchplan-media/post", {"text": "x", "token": "c"})
        assert status == 403 and found["front"]["desk"] == "/?view=frontdesk"
        assert "/work/<anchor>/post" in call("GET", "/")[1]["post"]
    finally:
        server.shutdown()
        server.server_close()
    bare = build_server("127.0.0.1", 0, Room(mirror=mirror), projects=talk.room)
    thread = threading.Thread(target=bare.serve_forever, daemon=True)
    thread.start()
    try:
        connection = HTTPConnection("127.0.0.1", bare.server_address[1], timeout=5)
        connection.request("GET", f"/work/{anchor}")
        assert connection.getresponse().status == 503
    finally:
        bare.shutdown()
        bare.server_close()
