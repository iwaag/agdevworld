import re
from datetime import datetime

import pytest
from agag.zulip import RESOLVED_TOPIC_PREFIX, ZulipError

from agdevworld_assistant import workflows
from agdevworld_assistant.workflows import (
    RetryingZulipClient,
    active_user_ids,
    handle_freeforge,
    handle_missions,
    stamped_topic_name,
)


class FakeClient:
    def __init__(self, message_id=77, fail_with=None):
        self.message_id = message_id
        self.fail_with = fail_with
        self.sent = []
        self.resolved = []

    def send_to_channel(self, channel, topic, content):
        if self.fail_with:
            raise self.fail_with
        self.sent.append((channel, topic, content))
        return self.message_id

    def resolve_topic(self, message_id, topic):
        if self.fail_with:
            raise self.fail_with
        if topic.startswith(RESOLVED_TOPIC_PREFIX):
            return
        self.resolved.append((message_id, topic))

    def users(self):
        return [
            {"user_id": 8, "is_active": True},
            {"user_id": 13},  # no flag at all counts as active, like the JS
            {"user_id": 5, "is_active": False},
        ]


# --- topic naming ------------------------------------------------------------

def test_stamped_topic_name_is_prefix_stamp_hex():
    topic = stamped_topic_name("create", datetime(2026, 8, 13, 9, 5, 7), "ab12cd")
    assert topic == "create-20260813-090507-ab12cd"


def test_stamped_topic_name_defaults_are_fresh_and_well_formed():
    topic = stamped_topic_name("mission")
    assert re.fullmatch(r"mission-\d{8}-\d{6}-[0-9a-f]{6}", topic)


# --- the active-user filter --------------------------------------------------

def test_active_user_ids_drops_only_the_deactivated():
    assert active_user_ids(FakeClient()) == [8, 13]


# --- the one-retry -----------------------------------------------------------

class Flaky(RetryingZulipClient):
    def __init__(self, errors):
        # No ZulipClient.__init__: this only exercises call()'s retry shell.
        self.errors = list(errors)
        self.calls = 0

    def _base_call(self, method, path, params=None, timeout=30):
        self.calls += 1
        if self.errors:
            raise self.errors.pop(0)
        return {"result": "success"}


@pytest.fixture(autouse=True)
def _route_super_call(monkeypatch):
    monkeypatch.setattr(
        "agag.zulip.ZulipClient.call",
        lambda self, method, path, params=None, timeout=30: self._base_call(method, path, params, timeout),
    )


def test_retries_once_on_a_socket_level_failure():
    client = Flaky([ZulipError("POST messages -> [Errno 104] reset")])
    assert client.call("POST", "messages") == {"result": "success"}
    assert client.calls == 2


def test_does_not_retry_an_http_level_error():
    client = Flaky([ZulipError("POST messages -> HTTP 400: bad topic")])
    with pytest.raises(ZulipError):
        client.call("POST", "messages")
    assert client.calls == 1


def test_a_second_socket_failure_escapes():
    client = Flaky([ZulipError("boom"), ZulipError("boom again")])
    with pytest.raises(ZulipError, match="boom again"):
        client.call("POST", "messages")
    assert client.calls == 2


# --- freeforge routes --------------------------------------------------------

def test_freeforge_request_opens_a_create_topic():
    client = FakeClient(message_id=41)
    code, body = handle_freeforge("/api/freeforge/requests", {"desire": " a red hat "}, client)
    assert code == 201
    assert body["kind"] == "freeforge.request.v1"
    assert body["channel"] == "FreeForge"
    assert body["message_id"] == 41
    assert body["topic"].startswith("create-")
    assert client.sent[0] == ("FreeForge", body["topic"], "a red hat")  # trimmed


@pytest.mark.parametrize("payload", [None, {}, {"desire": ""}, {"desire": "  "}, {"desire": 3}, []])
def test_freeforge_request_validates_the_desire(payload):
    code, body = handle_freeforge("/api/freeforge/requests", payload, FakeClient())
    assert (code, body["error"]) == (400, "bad_request")


def test_freeforge_resolve_round_trips_the_message_id():
    client = FakeClient()
    code, body = handle_freeforge("/api/freeforge/resolve", {"message_id": 41, "topic": "create-x"}, client)
    assert (code, body) == (200, {"kind": "freeforge.resolve.v1", "message_id": 41})
    assert client.resolved == [(41, "create-x")]


@pytest.mark.parametrize("payload", [
    None, {}, {"message_id": "41", "topic": "t"}, {"message_id": 4.5, "topic": "t"},
    {"message_id": True, "topic": "t"}, {"message_id": 41, "topic": ""}, {"message_id": 41},
])
def test_freeforge_resolve_validates_message_id_and_topic(payload):
    code, body = handle_freeforge("/api/freeforge/resolve", payload, FakeClient())
    assert (code, body["error"]) == (400, "bad_request")


def test_freeforge_unknown_path_is_not_found():
    code, body = handle_freeforge("/api/freeforge/other", {"x": 1}, FakeClient())
    assert (code, body["error"]) == (404, "not_found")


def test_freeforge_zulip_failure_maps_to_502():
    client = FakeClient(fail_with=ZulipError("POST messages -> HTTP 500: down"))
    code, body = handle_freeforge("/api/freeforge/requests", {"desire": "x"}, client)
    assert (code, body["error"]) == (502, "zulip_unavailable")
    assert "down" in body["detail"]


# --- mission routes ----------------------------------------------------------

def test_mission_opens_a_mission_topic_in_the_project_channel():
    client = FakeClient(message_id=9)
    code, body = handle_missions("/api/autolab/missions", {"project": "p3-smoke-1", "briefing": " go "}, client)
    assert code == 201
    assert body["kind"] == "autolab.mission.v1"
    assert body["channel"] == "pj-p3-smoke-1"
    assert body["topic"].startswith("mission-")
    assert client.sent[0] == ("pj-p3-smoke-1", body["topic"], "go")


@pytest.mark.parametrize("payload", [
    None, {}, {"project": "Bad_Name", "briefing": "b"}, {"project": "x", "briefing": "b"},
    {"project": "ok-name", "briefing": ""}, {"project": "ok-name"},
])
def test_mission_validates_project_and_briefing(payload):
    code, body = handle_missions("/api/autolab/missions", payload, FakeClient())
    assert (code, body["error"]) == (400, "bad_request")


def test_mission_resolve_answers_its_own_kind():
    client = FakeClient()
    code, body = handle_missions("/api/autolab/missions/resolve", {"message_id": 7, "topic": "mission-x"}, client)
    assert (code, body) == (200, {"kind": "autolab.mission-resolve.v1", "message_id": 7})
    assert client.resolved == [(7, "mission-x")]


def test_mission_zulip_failure_maps_to_502():
    client = FakeClient(fail_with=ZulipError("no Zulip credentials at /run/secrets/zulip.env"))
    code, body = handle_missions("/api/autolab/missions", {"project": "ok-name", "briefing": "b"}, client)
    assert (code, body["error"]) == (502, "zulip_unavailable")
