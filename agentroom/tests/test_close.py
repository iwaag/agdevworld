"""Closing a request (`front_desk` p3 step 2).

Fixtures only. What is pinned: the order — related topics, then the
selected conversation last; an already-resolved target being a successful
no-op; an unreadable topic blocking and keeping the selected conversation
open; a partial API failure reported per target and retried without
repeating what worked; and a plan that changed since the preview refusing
to write at all.

The chain is a Front Desk conversation that served an agent's topic, which
in turn served two nested topics of its own: one already ✔, one open.
"""

import json
import threading
from http.client import HTTPConnection

import pytest

from conftest import empty_room
from agentroom.close import (
    ALREADY, APPLIED, BLOCKED, DONE, FAILED, READY, SKIPPED, Closer,
)
from agentroom.server import build_server

DESK = "20260908-1600"
DESK_TOPIC = f"front-desk-{DESK}"
ROOT = ("front", DESK_TOPIC)
FRONT_BOT, AGENT_BOT, DEVELOPER = 15, 11, 8
AGENT = "agecho-agstudio1"
AGENT_CHANNEL = AGENT
PLAN_TOPIC = "agechoplan-x"
DONE_TOPIC = "agechorun-x"
OPEN_TOPIC = "agechonote-x"
OTHER_CHANNEL = "agother-agstudio1"
OTHER_TOPIC = "agotherplan-y"


def post(ident, content, *, sender_id=FRONT_BOT, sender="Front"):
    return {"id": ident, "sender_id": sender_id, "sender_full_name": sender,
            "sender_realm_str": "agdev", "timestamp": 1_800_000_000 + ident,
            "content": content}


def selfnote(ident, tag, value, **kwargs):
    return post(ident, f"[selfnote][{tag}] {value}", **kwargs)


def agent(ident, content):
    return post(ident, content, sender_id=AGENT_BOT, sender=AGENT)


class Realm:
    """Topic histories under whichever name each one actually has, and the
    one write this operation makes: a resolve."""

    def __init__(self, histories, topics, streams, fail=()):
        self.histories = dict(histories)
        self.topics = dict(topics)
        self.streams = dict(streams)
        self.fail = set(fail)
        self.resolved = []

    def topic_history(self, channel, topic, num_before=50):
        if channel in self.fail:
            raise ConnectionError("realm down")
        return list(self.histories.get((channel, topic), []))

    def stream_id(self, name):
        if name not in self.streams:
            raise KeyError(name)
        return self.streams[name]

    def channel_topics(self, stream_id):
        for name, ident in self.streams.items():
            if ident == stream_id:
                if name in self.fail:
                    raise ConnectionError("realm down")
                return list(self.topics.get(name, []))
        raise KeyError(stream_id)

    def channels(self):
        return [{"name": name, "stream_id": ident} for name, ident in self.streams.items()]

    def resolve_topic(self, message_id, topic):
        if topic in self.fail:
            raise ConnectionError("realm refused the rename")
        self.resolved.append((message_id, topic))
        for (channel, name), history in list(self.histories.items()):
            if name.removeprefix("✔ ") == topic:
                self.histories.pop((channel, name))
                self.histories[(channel, f"✔ {topic}")] = history
                self.topics[channel] = [
                    f"✔ {topic}" if one.removeprefix("✔ ") == topic else one
                    for one in self.topics.get(channel, [])
                ]


def chain(fail=()):
    histories = {
        ("front", DESK_TOPIC): [
            post(1, "Please do the thing.", sender_id=DEVELOPER, sender="Developer"),
            selfnote(2, "served", f"{AGENT_CHANNEL}/{PLAN_TOPIC} 1"),
            post(3, "Done."),
        ],
        (AGENT_CHANNEL, PLAN_TOPIC): [
            selfnote(10, "rootchat", f"front/{DESK_TOPIC}", sender_id=AGENT_BOT, sender=AGENT),
            agent(11, "planned"),
            selfnote(12, "served", f"{AGENT_CHANNEL}/{DONE_TOPIC} 1",
                     sender_id=AGENT_BOT, sender=AGENT),
            selfnote(13, "served", f"{AGENT_CHANNEL}/{OPEN_TOPIC} 1",
                     sender_id=AGENT_BOT, sender=AGENT),
        ],
        (AGENT_CHANNEL, f"✔ {DONE_TOPIC}"): [
            selfnote(20, "rootchat", f"{AGENT_CHANNEL}/{PLAN_TOPIC}",
                     sender_id=AGENT_BOT, sender=AGENT),
            agent(21, "ran"),
        ],
        (AGENT_CHANNEL, OPEN_TOPIC): [
            selfnote(30, "rootchat", f"{AGENT_CHANNEL}/{PLAN_TOPIC}",
                     sender_id=AGENT_BOT, sender=AGENT),
            agent(31, "noted"),
        ],
    }
    topics = {"front": [DESK_TOPIC],
              AGENT_CHANNEL: [PLAN_TOPIC, f"✔ {DONE_TOPIC}", OPEN_TOPIC]}
    streams = {"front": 24, AGENT_CHANNEL: 34, OTHER_CHANNEL: 40}
    return Realm(histories, topics, streams, fail=fail)


def with_unreadable_branch(realm):
    """The desk also served a topic in a channel nobody can read."""
    realm.histories[("front", DESK_TOPIC)].insert(
        2, selfnote(4, "served", f"{OTHER_CHANNEL}/{OTHER_TOPIC} 1"))
    realm.fail.add(OTHER_CHANNEL)
    return realm


def closer(realm=None, write=True):
    realm = realm if realm is not None else chain()
    return Closer(
        topics=dict,
        reader_factory=lambda: realm,
        writer_factory=(lambda: realm) if write else None,
    ), realm


def resolved_topics(realm):
    return [topic for _, topic in realm.resolved]


# --- the preview -------------------------------------------------------------


def test_the_plan_is_topics_then_the_conversation():
    door, _ = closer()
    found = door.plan(ROOT)
    assert [action["kind"] for action in found["actions"]] == [
        "topic", "topic", "topic", "conversation"]
    assert found["actions"][-1]["key"] == f"topic:front/{DESK_TOPIC}"


def test_an_already_resolved_topic_is_a_no_op_not_a_target():
    door, _ = closer()
    found = door.plan(ROOT)
    row = next(a for a in found["actions"] if a["key"].endswith(DONE_TOPIC))
    assert (row["state"], row["reason"]) == (DONE, "already ✔")


def test_a_topic_that_could_not_be_read_blocks_instead_of_resolving():
    door, _ = closer(realm=with_unreadable_branch(chain()))
    found = door.plan(ROOT)
    row = next(a for a in found["actions"] if a["key"].endswith(OTHER_TOPIC))
    assert row["state"] == BLOCKED and "could not be read" in row["reason"]


def test_the_preview_says_what_this_operation_is_not():
    door, _ = closer()
    assert door.plan(ROOT)["note"] == "this closes work; it does not stop a running agent"


def test_an_unconfigured_write_credential_is_said_at_preview_time():
    door, _ = closer(write=False)
    found = door.plan(ROOT)
    assert found["status"]["zulip_write"] is False
    assert "no write credential" in found["status"]["reason"]
    assert door.close(ROOT)["error"] == found["status"]["reason"]


def test_a_bad_conversation_id_is_refused_by_both_halves():
    door, _ = closer()
    assert "not a Front Desk conversation id" in door.plan(Closer.desk_key("../etc"))["error"]
    assert "not a Front Desk conversation id" in door.close(Closer.desk_key("../etc"))["error"]


# --- carrying it out ---------------------------------------------------------


def test_everything_closes_in_order_and_the_conversation_last():
    door, realm = closer()
    found = door.close(ROOT)
    assert found["applied"] is True and found["partial"] is False
    assert resolved_topics(realm) == [PLAN_TOPIC, OPEN_TOPIC, DESK_TOPIC]
    outcomes = {row["key"]: row["outcome"] for row in found["results"]}
    assert outcomes[f"topic:{AGENT_CHANNEL}/{DONE_TOPIC}"] == ALREADY
    assert outcomes[f"topic:front/{DESK_TOPIC}"] == APPLIED


def test_a_blocked_target_keeps_the_front_conversation_open():
    door, realm = closer(realm=with_unreadable_branch(chain()))
    found = door.close(ROOT)
    assert found["partial"] is True
    front = next(row for row in found["results"] if row["key"] == f"topic:front/{DESK_TOPIC}")
    assert front["outcome"] == SKIPPED and "kept open" in front["note"]
    assert DESK_TOPIC not in resolved_topics(realm)
    # The readable branch still closes.
    assert PLAN_TOPIC in resolved_topics(realm)


def test_a_failed_target_is_reported_and_the_others_still_close():
    door, realm = closer(realm=chain(fail=(OPEN_TOPIC,)))
    found = door.close(ROOT)
    assert found["partial"] is True
    failed = next(row for row in found["results"] if row["key"].endswith(OPEN_TOPIC))
    assert failed["outcome"] == FAILED and "realm refused" in failed["note"]
    assert PLAN_TOPIC in resolved_topics(realm)
    assert DESK_TOPIC not in resolved_topics(realm)


def test_a_retry_finishes_what_is_left_and_repeats_nothing():
    door, realm = closer(realm=chain(fail=(OPEN_TOPIC,)))
    door.close(ROOT)
    assert resolved_topics(realm) == [PLAN_TOPIC]
    realm.fail.clear()
    again = door.close(ROOT)
    assert again["partial"] is False
    assert resolved_topics(realm) == [PLAN_TOPIC, OPEN_TOPIC, DESK_TOPIC]
    outcomes = {row["key"]: row["outcome"] for row in again["results"]}
    assert outcomes[f"topic:{AGENT_CHANNEL}/{PLAN_TOPIC}"] == ALREADY
    assert outcomes[f"topic:{AGENT_CHANNEL}/{OPEN_TOPIC}"] == APPLIED
    assert outcomes[f"topic:front/{DESK_TOPIC}"] == APPLIED
    assert len(door.records(ROOT)) == 2


def test_closing_an_already_closed_conversation_writes_nothing():
    door, realm = closer()
    door.close(ROOT)
    resolved = len(realm.resolved)
    again = door.close(ROOT)
    assert len(realm.resolved) == resolved
    assert {row["outcome"] for row in again["results"]} <= {ALREADY, SKIPPED}


# --- the preview is what is approved -----------------------------------------


def test_a_plan_that_changed_since_the_preview_refuses_and_writes_nothing():
    door, realm = closer()
    stale = door.plan(ROOT)["fingerprint"]
    # A topic opened after the human looked: a new target.
    realm.topics[AGENT_CHANNEL].append("agechomore-x")
    realm.histories[(AGENT_CHANNEL, "agechomore-x")] = [
        selfnote(40, "rootchat", f"{AGENT_CHANNEL}/{PLAN_TOPIC}", sender_id=AGENT_BOT, sender=AGENT),
        agent(41, "more"),
    ]
    realm.histories[(AGENT_CHANNEL, PLAN_TOPIC)].append(
        selfnote(42, "served", f"{AGENT_CHANNEL}/agechomore-x 1", sender_id=AGENT_BOT, sender=AGENT))
    found = door.close(ROOT, stale)
    assert found["refused"] is True and "nothing was closed" in found["error"]
    assert realm.resolved == []
    assert found["fingerprint"] != stale
    assert any(a["key"].endswith("agechomore-x") for a in found["actions"])


def test_the_fingerprint_ignores_a_new_post_and_notices_a_new_state():
    first = closer()[0].plan(ROOT)
    chatty = chain()
    chatty.histories[(AGENT_CHANNEL, PLAN_TOPIC)].append(agent(99, "one more word"))
    assert closer(realm=chatty)[0].plan(ROOT)["fingerprint"] == first["fingerprint"]
    moved = chain()
    moved.resolve_topic(31, OPEN_TOPIC)
    moved.resolved.clear()
    assert closer(realm=moved)[0].plan(ROOT)["fingerprint"] != first["fingerprint"]


def test_the_approved_fingerprint_is_optional():
    door, realm = closer()
    assert door.close(ROOT, None)["applied"] is True
    assert resolved_topics(realm) == [PLAN_TOPIC, OPEN_TOPIC, DESK_TOPIC]


def test_two_clicks_do_not_both_close():
    door, realm = closer()
    results = []

    def click():
        results.append(door.close(ROOT))

    threads = [threading.Thread(target=click) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert resolved_topics(realm) == [PLAN_TOPIC, OPEN_TOPIC, DESK_TOPIC]
    assert sum(1 for found in results for row in found["results"]
               if row["kind"] == "conversation" and row["outcome"] == APPLIED) == 1


# --- the routes --------------------------------------------------------------


@pytest.fixture()
def relay():
    door, realm = closer()
    server = build_server("127.0.0.1", 0, empty_room(), closer=door)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server.server_address[1], door, realm
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
    port, _, realm = relay
    status, found = request(port, "GET", f"/frontdesk/{DESK}/close-plan")
    assert status == 200 and found["topic"] == DESK_TOPIC and found["scope"]["kind"] == "desk"
    assert realm.resolved == []
    status, applied = request(port, "POST", f"/frontdesk/{DESK}/close",
                              {"fingerprint": found["fingerprint"]})
    assert status == 200 and applied["applied"] is True
    assert resolved_topics(realm) == [PLAN_TOPIC, OPEN_TOPIC, DESK_TOPIC]


def test_a_stale_approval_is_409_over_http(relay):
    port, _, realm = relay
    status, found = request(port, "POST", f"/frontdesk/{DESK}/close",
                            {"fingerprint": "0000000000000000"})
    assert status == 409 and found["refused"] is True
    assert realm.resolved == []


def test_the_close_route_takes_no_destinations(relay):
    """Whatever the browser sends beside the id and the fingerprint is
    ignored: the server closes what it derived, never what it was told."""
    port, _, realm = relay
    status, _ = request(port, "POST", f"/frontdesk/{DESK}/close",
                        {"topics": ["front/front-desk-somebody-else"],
                         "channels": ["general"]})
    assert status == 200
    assert resolved_topics(realm) == [PLAN_TOPIC, OPEN_TOPIC, DESK_TOPIC]


def test_a_bad_id_is_400_over_http(relay):
    port = relay[0]
    assert request(port, "GET", "/frontdesk/NOT%20AN%20ID/close-plan")[0] == 400
    assert request(port, "POST", "/frontdesk/NOT%20AN%20ID/close", {})[0] == 400


def test_the_answer_to_a_close_is_the_plan_as_it_now_stands():
    """p4 step 2, met in a browser fixture: a retry that carried the
    pre-write fingerprint was always refused. The answer's fingerprint is
    the post-write plan's, so 'try the rest again' approves what is left."""
    door, realm = closer(realm=chain(fail=(OPEN_TOPIC,)))
    first = door.close(ROOT)
    assert first["partial"] is True
    by_key = {row["key"]: row for row in first["actions"]}
    assert by_key[f"topic:{AGENT_CHANNEL}/{PLAN_TOPIC}"]["state"] == DONE
    assert by_key[f"topic:{AGENT_CHANNEL}/{OPEN_TOPIC}"]["state"] == READY
    assert by_key[f"topic:front/{DESK_TOPIC}"]["state"] == READY
    assert first["counts"]["ready"] == 2
    assert first["fingerprint"] == door.plan(ROOT)["fingerprint"]
    realm.fail.clear()
    again = door.close(ROOT, first["fingerprint"])
    assert again.get("refused") is None and again["partial"] is False
    assert again["counts"]["ready"] == 0


# --- the mirror confirms the writes (better_zulip_call p1 step 3) ---------------


def test_each_applied_write_is_confirmed_once_the_mirror_carries_it_back():
    """The answer to a close waits, briefly, for the mirror's copy to show
    what was written, and every applied result says whether it did."""
    import time as _time

    from agag.mirror.testing import FakeRealm
    from agentroom.realm import MirrorRealm
    from conftest import mirror_over

    realm = FakeRealm()
    realm.add_channel(35, "agents")
    realm.add_channel(5, "front")
    realm.post("front", "front-desk-1", "please do a thing", sender_id=DEVELOPER, sender_name="Developer", quiet=True)
    realm.post("front", "front-desk-1", "done.", sender_id=FRONT_BOT,
               sender_name="Front", quiet=True)
    mirror = mirror_over(realm)
    mirror.start()  # the ingest thread applies what the writer changes

    class Writer:
        """The Developer's credential: its resolve is a real rename in the
        realm, which the mirror learns of through its queue."""

        def __init__(self, touch_realm=True):
            self.touch_realm, self.resolved = touch_realm, []

        def resolve_topic(self, message_id, topic):
            self.resolved.append((message_id, topic))
            if self.touch_realm:
                realm.resolve("front", topic)

    writer = Writer()
    door = Closer(topics=lambda: {}, reader_factory=lambda: MirrorRealm(mirror),
                  writer_factory=lambda: writer, mirror=mirror, confirm_seconds=3.0)
    plan = door.plan(("front", "front-desk-1"))
    assert plan["counts"]["ready"] == 1 and plan["gaps"]["zulip_calls"] == 0
    started = _time.time()
    closed = door.close(("front", "front-desk-1"), plan["fingerprint"])
    assert closed["applied"] and not closed["partial"]
    assert [(row["outcome"], row["confirmed"]) for row in closed["results"]] == [(APPLIED, True)]
    assert _time.time() - started < 3.0  # confirmed as soon as the event landed, not at the deadline
    assert closed["actions"][0]["state"] == DONE  # the post-write plan read the resolve off the copy
    mirror.stop()

    # A write the realm never carried back stays unconfirmed, and says so.
    realm2 = FakeRealm()
    realm2.add_channel(35, "agents")
    realm2.add_channel(5, "front")
    realm2.post("front", "front-desk-2", "please", sender_id=DEVELOPER, sender_name="Developer", quiet=True)
    mirror2 = mirror_over(realm2)
    silent = Writer(touch_realm=False)
    door2 = Closer(topics=lambda: {}, reader_factory=lambda: MirrorRealm(mirror2),
                   writer_factory=lambda: silent, mirror=mirror2, confirm_seconds=0.3)
    plan2 = door2.plan(("front", "front-desk-2"))
    closed2 = door2.close(("front", "front-desk-2"), plan2["fingerprint"])
    assert [(row["outcome"], row["confirmed"]) for row in closed2["results"]] == [(APPLIED, False)]
