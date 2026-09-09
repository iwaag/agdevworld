"""Closing a Front Desk conversation (`front_desk` p3 step 2).

Fixtures only. What is pinned: the order Plane → topics → channels → Front;
the shared parent/child rule deciding each Work; an already-closed target
being a successful no-op; a cancelled Work being left alone; a blocked
target keeping the Front conversation open; a partial API failure reported
per target and retried without repeating what worked; and a plan that
changed since the preview refusing to write at all.
"""

import json
import threading
from http.client import HTTPConnection

import pytest

from agentroom.close import (
    ALREADY, APPLIED, BLOCKED, DONE, FAILED, KEPT, READY, SKIPPED, Closer, fingerprint,
    plan_actions,
)
from agentroom.closing import discover
from agentroom.room import Room
from agentroom.server import build_server

from test_closing import (
    DESK, DESK_TOPIC, ROOT, FREEFORGE, GHTRENDS, MISSION, TASK, Board, board, chain_realm, issue,
    post, selfnote,
)


class WritingRealm:
    """A read realm that also takes the two writes this operation makes."""

    def __init__(self, realm, fail=()):
        self.realm, self.fail = realm, set(fail)
        self.resolved, self.archived = [], []

    def __getattr__(self, name):
        return getattr(self.realm, name)

    def resolve_topic(self, message_id, topic):
        if topic in self.fail:
            raise ConnectionError("realm refused the rename")
        self.resolved.append((message_id, topic))
        for (channel, name), history in list(self.realm.histories.items()):
            if name.lstrip("✔ ") == topic:
                self.realm.histories.pop((channel, name))
                self.realm.histories[(channel, f"✔ {topic}")] = history
                self.realm.topics[channel] = [
                    f"✔ {topic}" if one.lstrip("✔ ") == topic else one
                    for one in self.realm.topics.get(channel, [])
                ]

    def archive_channel(self, stream_id):
        if stream_id in self.fail:
            raise ConnectionError("not an administrator of this channel")
        self.archived.append(stream_id)
        # An archived channel leaves every listing, so a second attempt finds
        # nothing to archive — which is what makes a retry a no-op here.
        for name, ident in list(self.realm.streams.items()):
            if ident == stream_id:
                self.realm.streams.pop(name)


class WritingBoard(Board):
    """A Plane that records the one write and applies it."""

    def __init__(self, *args, fail=(), **kwargs):
        super().__init__(*args, **kwargs)
        self.completed, self.write_fail = [], set(fail)

    def complete(self, project_id, issue_id):
        if issue_id in self.write_fail:
            raise ConnectionError("Plane refused")
        self.completed.append((project_id, issue_id))
        for row in self._issues[project_id]:
            if str(row["id"]) == issue_id:
                row["state"] = "s-done" if project_id == GHTRENDS else "f-done"


def writing_board(**kwargs):
    base = board(**{k: v for k, v in kwargs.items() if k in {"extra_ghtrends", "refuse"}})
    return WritingBoard(base._projects, base._issues, base._groups,
                        refuse=base.refuse, fail=kwargs.get("fail", ()))


def open_chain(**kwargs):
    """The same chain with its forge half still open, so there is more than
    one topic for this operation to resolve."""
    realm = chain_realm(**kwargs)
    for channel, topic in list(realm.histories):
        if channel == "agforge-agstudio1":
            realm.histories[(channel, topic.removeprefix("✔ "))] = realm.histories.pop(
                (channel, topic))
    realm.topics["agforge-agstudio1"] = ["assetplan-robot", "assetrun-robot"]
    return realm


def closer(realm=None, plane=None, topics=None, write=True):
    realm = realm if realm is not None else WritingRealm(chain_realm())
    plane = plane if plane is not None else writing_board()
    return Closer(
        topics=(lambda: dict(topics or {})),
        reader_factory=lambda: realm,
        writer_factory=(lambda: realm) if write else None,
        plane_factory=lambda: plane,
    ), realm, plane


# --- the preview -------------------------------------------------------------


def test_the_plan_is_plane_then_topics_then_channels_then_the_conversation():
    door, _, _ = closer()
    found = door.plan(ROOT)
    kinds = [action["kind"] for action in found["actions"]]
    assert kinds == ["work", "work", "work", "topic", "topic", "topic", "topic",
                     "channel", "conversation"]
    assert found["actions"][-1]["key"] == f"topic:front/{DESK_TOPIC}"


def test_a_mission_with_every_sub_work_completed_is_ready_and_says_why():
    door, _, _ = closer()
    work = next(a for a in door.plan(ROOT)["actions"] if a["key"] == f"work:{MISSION}")
    assert work["state"] == READY
    assert work["reason"] == "every one of its 1 sub-works is completed"


def test_an_unfinished_sub_work_blocks_its_mission():
    plane = writing_board(extra_ghtrends=(
        issue("open", sequence=19, name="Still running", state="s-started", parent=MISSION),))
    door, _, _ = closer(plane=plane)
    found = door.plan(ROOT)
    work = next(a for a in found["actions"] if a["key"] == f"work:{MISSION}")
    assert work["state"] == BLOCKED
    assert work["reason"] == "1 of 2 sub-works are not completed"


def test_a_standalone_work_is_blocked_rather_than_completed_by_this_button():
    door, _, _ = closer()
    work = next(a for a in door.plan(ROOT)["actions"] if a["label"].startswith("F2-28"))
    # F2-28 is already Done; a standalone Work that is not would be blocked.
    assert work["state"] == DONE
    plane = writing_board()
    plane._issues[FREEFORGE][0]["state"] = "f-open"
    plane._groups[FREEFORGE]["f-open"] = "started"
    door, _, _ = closer(plane=plane)
    work = next(a for a in door.plan(ROOT)["actions"] if a["label"].startswith("F2-28"))
    assert (work["state"], work["reason"]) == (BLOCKED, "no sub-work: this is not a mission")


def test_a_cancelled_work_is_kept_exactly_as_it_is():
    plane = writing_board()
    plane._issues[GHTRENDS][0]["state"] = "s-cancel"
    door, _, _ = closer(plane=plane)
    work = next(a for a in door.plan(ROOT)["actions"] if a["key"] == f"work:{MISSION}")
    assert work["state"] == KEPT and "never moves a cancelled Work" in work["reason"]
    door.close(ROOT)
    assert plane.completed == []


def test_an_already_resolved_topic_is_a_no_op_not_a_target():
    door, _, _ = closer()
    found = door.plan(ROOT)
    run = next(a for a in found["actions"] if a["key"].endswith("workrun-task1-g-17"))
    assert (run["state"], run["reason"]) == (DONE, "already ✔")


def test_a_topic_that_could_not_be_read_blocks_instead_of_resolving():
    realm = WritingRealm(chain_realm(fail=("work-g-17",)))
    door, _, _ = closer(realm=realm)
    found = door.plan(ROOT)
    run = next(a for a in found["actions"] if a["key"].endswith("workrun-task1-g-17"))
    assert run["state"] == BLOCKED and "could not be read" in run["reason"]


def test_the_preview_says_what_this_operation_is_not():
    door, _, _ = closer()
    assert door.plan(ROOT)["note"] == "this closes work; it does not stop a running agent"


def test_an_unconfigured_write_credential_is_said_at_preview_time():
    door, _, _ = closer(write=False)
    found = door.plan(ROOT)
    assert found["status"]["zulip_write"] is False
    assert "no write credential" in found["status"]["reason"]
    assert door.close(ROOT)["error"] == found["status"]["reason"]


def test_a_bad_conversation_id_is_refused_by_both_halves():
    door, _, _ = closer()
    assert "not a Front Desk conversation id" in door.plan(Closer.desk_key("../etc"))["error"]
    assert "not a Front Desk conversation id" in door.close(Closer.desk_key("../etc"))["error"]


# --- carrying it out ---------------------------------------------------------


def test_everything_closes_in_order_and_the_conversation_last():
    door, realm, plane = closer(realm=WritingRealm(open_chain()))
    found = door.close(ROOT)
    assert found["applied"] is True and found["partial"] is False
    assert plane.completed == [(GHTRENDS, MISSION)]
    assert [topic for _, topic in realm.resolved] == [
        "workplan-trend8", "assetplan-robot", "assetrun-robot", DESK_TOPIC]
    assert realm.archived == [122]
    outcomes = {row["key"]: row["outcome"] for row in found["results"]}
    assert outcomes[f"work:{MISSION}"] == APPLIED
    assert outcomes[f"work:{TASK}"] == ALREADY
    assert outcomes[f"topic:front/{DESK_TOPIC}"] == APPLIED


def test_a_blocked_target_keeps_the_front_conversation_open():
    plane = writing_board(extra_ghtrends=(
        issue("open", sequence=19, name="Still running", state="s-started", parent=MISSION),))
    door, realm, _ = closer(plane=plane)
    found = door.close(ROOT)
    assert found["partial"] is True
    front = next(row for row in found["results"] if row["key"] == f"topic:front/{DESK_TOPIC}")
    assert front["outcome"] == SKIPPED and "kept open" in front["note"]
    assert DESK_TOPIC not in [topic for _, topic in realm.resolved]


def test_a_failed_target_is_reported_and_the_others_still_close():
    realm = WritingRealm(open_chain(), fail=("assetrun-robot",))
    door, realm, plane = closer(realm=realm)
    found = door.close(ROOT)
    assert found["partial"] is True
    failed = next(row for row in found["results"] if row["key"].endswith("assetrun-robot"))
    assert failed["outcome"] == FAILED and "realm refused" in failed["note"]
    # The Work and the other topics went through; the Front topic did not.
    assert plane.completed == [(GHTRENDS, MISSION)]
    assert "workplan-trend8" in [topic for _, topic in realm.resolved]
    assert DESK_TOPIC not in [topic for _, topic in realm.resolved]


def test_a_channel_that_cannot_be_archived_is_reported_per_target():
    realm = WritingRealm(open_chain(), fail=(122,))
    door, realm, _ = closer(realm=realm)
    found = door.close(ROOT)
    row = next(one for one in found["results"] if one["kind"] == "channel")
    assert row["outcome"] == FAILED and "administrator" in row["note"]


def test_an_archived_channel_reads_as_done_rather_than_unreadable():
    """The live run met this: an archived channel is gone from every listing,
    so its topics stop being readable and the second preview must not report
    this operation's own finished work as a gap."""
    door, realm, _ = closer(realm=WritingRealm(open_chain()))
    door.close(ROOT)
    again = door.plan(ROOT)
    row = next(one for one in again["actions"] if one["kind"] == "channel")
    assert row["state"] == DONE
    assert row["reason"] == "already archived: the realm no longer lists this channel"
    assert again["counts"]["ready"] == 0


def test_a_retry_finishes_what_is_left_and_repeats_nothing():
    realm = WritingRealm(open_chain(), fail=("assetrun-robot",))
    door, realm, plane = closer(realm=realm)
    door.close(ROOT)
    assert len(plane.completed) == 1
    realm.fail.clear()
    again = door.close(ROOT)
    assert again["partial"] is False
    # The Work was Done already, so Plane was not written a second time.
    assert plane.completed == [(GHTRENDS, MISSION)]
    outcomes = {row["key"]: row["outcome"] for row in again["results"]}
    assert outcomes[f"work:{MISSION}"] == ALREADY
    assert outcomes["topic:pj-ghtrends/workplan-trend8"] == ALREADY
    assert outcomes["topic:agforge-agstudio1/assetrun-robot"] == APPLIED
    assert outcomes[f"topic:front/{DESK_TOPIC}"] == APPLIED
    assert door.records(ROOT) and len(door.records(ROOT)) == 2


def test_closing_an_already_closed_conversation_writes_nothing():
    door, realm, plane = closer(realm=WritingRealm(open_chain()))
    door.close(ROOT)
    resolved, completed, archived = len(realm.resolved), len(plane.completed), len(realm.archived)
    again = door.close(ROOT)
    assert (len(realm.resolved), len(plane.completed), len(realm.archived)) == (
        resolved, completed, archived)
    assert {row["outcome"] for row in again["results"]} <= {ALREADY, SKIPPED}


# --- the preview is what is approved -----------------------------------------


def test_a_plan_that_changed_since_the_preview_refuses_and_writes_nothing():
    door, realm, plane = closer(realm=WritingRealm(open_chain()))
    stale = door.plan(ROOT)["fingerprint"]
    # A Sub-Work opened after the human looked: the mission is no longer ready.
    plane._issues[GHTRENDS].append(
        issue("late", sequence=19, name="Opened since", state="s-started", parent=MISSION))
    found = door.close(ROOT, stale)
    assert found["refused"] is True and "nothing was closed" in found["error"]
    assert plane.completed == [] and realm.resolved == [] and realm.archived == []
    # The refusal carries the plan to approve instead.
    assert found["fingerprint"] != stale
    assert next(a for a in found["actions"] if a["key"] == f"work:{MISSION}")["state"] == BLOCKED


def test_the_fingerprint_ignores_a_new_post_and_notices_a_new_state():
    door, _, plane = closer()
    first = door.plan(ROOT)
    realm = WritingRealm(chain_realm())
    realm.realm.histories[("pj-ghtrends", "workplan-trend8")].append(post(99, "one more word"))
    door_two, _, _ = closer(realm=realm, plane=plane)
    assert door_two.plan(ROOT)["fingerprint"] == first["fingerprint"]
    plane._issues[GHTRENDS][0]["state"] = "s-cancel"
    assert door.plan(ROOT)["fingerprint"] != first["fingerprint"]


def test_the_approved_fingerprint_is_optional():
    door, _, plane = closer()
    assert door.close(ROOT, None)["applied"] is True
    assert plane.completed == [(GHTRENDS, MISSION)]


def test_two_clicks_do_not_both_close():
    door, realm, plane = closer(realm=WritingRealm(open_chain()))
    results = []

    def click():
        results.append(door.close(ROOT))

    threads = [threading.Thread(target=click) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(plane.completed) == 1
    assert sum(1 for found in results
               for row in found["results"]
               if row["kind"] == "channel" and row["outcome"] == APPLIED) == 1


# --- the routes --------------------------------------------------------------


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


def test_the_plan_route_reads_and_the_close_route_writes(relay):
    port, _, realm, plane = relay
    status, found = request(port, "GET", f"/frontdesk/{DESK}/close-plan")
    assert status == 200 and found["topic"] == DESK_TOPIC and found["scope"]["kind"] == "desk"
    assert plane.completed == [] and realm.resolved == []
    status, applied = request(port, "POST", f"/frontdesk/{DESK}/close",
                              {"fingerprint": found["fingerprint"]})
    assert status == 200 and applied["applied"] is True
    assert plane.completed == [(GHTRENDS, MISSION)]


def test_a_stale_approval_is_409_over_http(relay):
    port, _, realm, plane = relay
    status, found = request(port, "POST", f"/frontdesk/{DESK}/close",
                            {"fingerprint": "0000000000000000"})
    assert status == 409 and found["refused"] is True
    assert plane.completed == [] and realm.resolved == []


def test_the_close_route_takes_no_destinations(relay):
    """Whatever the browser sends beside the id and the fingerprint is
    ignored: the server closes what it derived, never what it was told."""
    port, _, realm, plane = relay
    status, found = request(port, "POST", f"/frontdesk/{DESK}/close",
                            {"topics": ["front/front-desk-somebody-else"],
                             "channels": ["general"]})
    assert status == 200
    assert [topic for _, topic in realm.resolved] == [
        "workplan-trend8", "assetplan-robot", "assetrun-robot", DESK_TOPIC]
    assert realm.archived == [122]


def test_a_bad_id_is_400_over_http(relay):
    port = relay[0]
    assert request(port, "GET", "/frontdesk/NOT%20AN%20ID/close-plan")[0] == 400
    assert request(port, "POST", "/frontdesk/NOT%20AN%20ID/close", {})[0] == 400
