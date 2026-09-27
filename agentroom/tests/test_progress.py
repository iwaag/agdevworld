"""The progress panel's read (`progress_panel` p1).

Pinned: every `front-*` request is a card of its own by its first post,
two requests sharing an agent keep their own trees and counts; the
viewer's conversation is pinned first; health checks run only for open
servings of probed owners, once per serving within their TTL, within a
budget, and a failing or silent probe is `unknown`; Observer's hold and
incidents reach the right card; a board is reused within its refresh bound
and costs no Zulip call at all; a stale mirror marks every card stale.
"""

import json
import threading
import time
from http.client import HTTPConnection
from types import SimpleNamespace

from conftest import FakeRealm, mirror_over, pump

from agentroom import progress as panel
from agentroom.progress import HealthChecks, ObserverRecords, Progress, recovery_for

ACK = "Message received. Please wait for the reply."
DEV, FRONT, AUTOLAB, OBSERVER = 8, 15, 11, 23
BASE = 1_790_000_000


def build(realm_setup=None):
    realm = FakeRealm()
    realm.base_url = "https://zulip.invalid"
    realm.add_channel(5, "front")
    realm.add_channel(6, "pj-demo")
    realm.add_channel(7, "work-m1")
    ids = {}
    t = BASE

    def say(channel, topic, content, sender, name, key=None):
        nonlocal t
        t += 10
        ident = realm.post(channel, topic, content, sender_id=sender, sender_name=name, timestamp=t, quiet=True)
        if key:
            ids[key] = ident
        return ident

    # Request A: Front plans a mission with autolab; task 1 runs.
    say("front", "front-desk-a", "please build the thing", DEV, "Developer", "a")
    say("front", "front-desk-a", ACK, FRONT, "Front")
    say("pj-demo", "workplan-a", f"[selfnote][rootchat] front/front-desk-a #{ids['a']}", FRONT, "Front")
    say("pj-demo", "workplan-a", "@**autolab** please plan", FRONT, "Front")
    say("pj-demo", "workplan-a", ACK, AUTOLAB, "autolab")
    say("pj-demo", "workplan-a", "[selfnote][mission] demo", AUTOLAB, "autolab", "mission")
    say("pj-demo", "workplan-a", "# plan", AUTOLAB, "autolab", "doc")
    say("pj-demo", "workplan-a", f"[selfnote][doc] {ids['doc']}", AUTOLAB, "autolab")
    say("work-m1", "workrun-task1", f"[selfnote][task] {ids['mission']}#1", AUTOLAB, "autolab", "task1")
    say("work-m1", "workrun-task1", f"[selfnote][rootchat] pj-demo/workplan-a #{ids['mission']}", AUTOLAB, "autolab")
    say("work-m1", "workrun-task1", "# task 1", AUTOLAB, "autolab")
    say("work-m1", "workrun-task2", f"[selfnote][task] {ids['mission']}#2", AUTOLAB, "autolab", "task2")
    say("work-m1", "workrun-task2", f"[selfnote][rootchat] pj-demo/workplan-a #{ids['mission']}", AUTOLAB, "autolab")
    say("work-m1", "workrun-task2", "# task 2", AUTOLAB, "autolab")
    say("pj-demo", "workplan-a", "[selfnote][state] started", AUTOLAB, "autolab")
    say("work-m1", "workrun-task1", "Task 1 starts now.", AUTOLAB, "autolab")
    say("work-m1", "workrun-task1", f"[selfnote][start] #{ids['mission']} for {FRONT} Front", AUTOLAB, "autolab")
    say("work-m1", "workrun-task1", ACK, AUTOLAB, "autolab", "ack1")
    say("front", "front-desk-a", "@**Developer** autolab is on it\n\n`ag-post intent=progress`", FRONT, "Front")
    # Request B, in another conversation, asks the same agent: a plain question.
    say("front", "front-desk-b", "what does task 1 do?", DEV, "Developer", "b")
    say("front", "front-desk-b", ACK, FRONT, "Front")
    say("front", "front-desk-b", "@**Developer** it builds.\n\n`ag-post intent=report`", FRONT, "Front")
    if realm_setup:
        realm_setup(realm, say, ids)
    return realm, ids, t


class Runner:
    """A health command: answers `running` for the ack it is asked about."""

    def __init__(self, verdict="running", fail=False, slow=0.0):
        self.calls, self.verdict, self.fail, self.slow = [], verdict, fail, slow

    def __call__(self, command, **kwargs):
        self.calls.append(command)
        if self.slow:
            time.sleep(self.slow)
        if self.fail:
            return SimpleNamespace(stdout="not json", returncode=1)
        ack = int(command[command.index("--ack") + 1])
        return SimpleNamespace(stdout=json.dumps({
            "schema": "agag.health.v1", "observed_at": time.time(), "verdict": self.verdict, "why": "because",
            "subject": {"ack": ack}, "progress": {"last_work": "tool Bash", "last_work_at": time.time() - 2}}),
            returncode=0)


def observer_dir(tmp_path, *, held=None, incidents=()):
    root = tmp_path / "observer"
    (root / "incidents").mkdir(parents=True)
    (root / "incidents" / "held.json").write_text(json.dumps(held or {}))
    for record in incidents:
        (root / "incidents" / f"{record['key'].replace(':', '_')}.json").write_text(json.dumps(record))
    (root / "health.toml").write_text('[owners."autolab"]\ncommand = ["probe"]\ntimeout = 5\n')
    (root / "monitor-health.json").write_text(json.dumps({"interval_seconds": 60,
                                                          "cycle": {"completed_at": time.time()}}))
    return root


def board_for(tmp_path, runner=None, *, now=None, held=None, incidents=(), setup=None):
    realm, ids, last = build(setup)
    mirror = mirror_over(realm)
    root = observer_dir(tmp_path, held=held, incidents=incidents)
    checks = HealthChecks(root / "health.toml", runner=runner or Runner())
    clock = (lambda: now) if now is not None else (lambda: last + 30)
    checks.clock = clock
    progress = Progress(ops=SimpleNamespace(mirror=mirror), observer=ObserverRecords(root), health=checks,
                        viewer=lambda: DEV, clock=clock)
    return progress, realm, ids, mirror


def card_of(board, topic):
    return next(c for c in board["cards"] if c["topic"] == topic)


def test_each_request_is_its_own_card_with_its_own_tree(tmp_path):
    progress, realm, ids, _ = board_for(tmp_path)
    board = progress.board()
    a, b = card_of(board, "front-desk-a"), card_of(board, "front-desk-b")
    assert (a["origin"], b["origin"]) == (ids["a"], ids["b"])
    assert a["state"] == "working" and b["state"] == "answered"
    plan = a["root"]["children"][0]["children"][0] if a["root"]["children"][0]["kind"] != "plan" \
        else a["root"]["children"][0]
    assert plan["kind"] == "plan" and plan["meter"]["total"] == 2 and plan["meter"]["completed"] == 0
    assert b["root"]["children"] == [] and b["group"] == "recent"
    assert a["desk"] == "a" and a["links"][str(a["anchor"])].startswith("https://zulip.invalid/#narrow/")


def test_the_open_serving_of_a_probed_owner_is_checked_once_per_ttl(tmp_path):
    runner = Runner()
    progress, realm, ids, _ = board_for(tmp_path, runner)
    board = progress.board()
    task = next(u for u in _units(card_of(board, "front-desk-a")) if u["kind"] == "task" and u["serial"] == 1)
    assert task["execution"]["evidence"] == "confirmed" and task["display"]["state"] == "working"
    assert len(runner.calls) == 1 and runner.calls[0][-6:] == ["--ack", str(ids["ack1"]), "--channel", "work-m1",
                                                               "--topic", "workrun-task1"]
    progress.board(fresh=True)
    assert len(runner.calls) == 1  # within PROBE_TTL
    # Task 2 waits for task 1: queued, never probed (no open serving).
    task2 = next(u for u in _units(card_of(board, "front-desk-a")) if u["kind"] == "task" and u["serial"] == 2)
    assert task2["display"]["state"] == "queued" and "after task 1" in task2["display"]["reason"]


def test_a_failing_or_silent_probe_is_unknown_and_bounded(tmp_path, monkeypatch):
    progress, *_ = board_for(tmp_path, Runner(fail=True))
    task = next(u for u in _units(card_of(progress.board(), "front-desk-a")) if u["kind"] == "task" and u["serial"] == 1)
    assert task["display"]["state"] == "unknown" and "probe" in task["display"]["reason"]
    monkeypatch.setattr(panel, "PROBE_BUDGET", 0.2)
    progress, *_ = board_for(tmp_path / "slow", Runner(slow=1.0))
    started = time.time()
    task = next(u for u in _units(card_of(progress.board(), "front-desk-a")) if u["kind"] == "task" and u["serial"] == 1)
    assert time.time() - started < 1.0
    assert task["display"]["state"] == "unknown" and "did not answer" in task["display"]["reason"]


def test_a_hold_and_observer_s_incidents_reach_their_own_card(tmp_path):
    """failsafe p6: a person's hold is a record in the request's own
    conversation, read like everything else on the card."""
    from agag.holds import hold_note

    def setup(realm, say, ids):
        say("front", "front-desk-a", hold_note("resume", ids["a"], DEV, "Developer", 0, "the Developer decides"),
            OBSERVER, "agobserver-agstudio1")

    realm, ids, _ = build()
    incident = {"key": f"o{ids['b']}:n{ids['b']}", "state": "detected", "kind": "unanswered",
                "origin": {"key": f"o{ids['b']}"}, "node": {"anchor": ids["b"]}, "fact": "no answer"}
    progress, *_ = board_for(tmp_path, incidents=[incident], setup=setup)
    board = progress.board()
    a, b = card_of(board, "front-desk-a"), card_of(board, "front-desk-b")
    assert a["state"] == "awaiting_you" and "the Developer decides" in a["reason"] and a["observer_held"]
    assert [h["state"] for h in a["holds"]] == ["held"]
    assert b["state"] == "stopped" and "no answer" in b["reason"]


def test_the_viewers_conversation_is_pinned_first_and_found_outside_the_bounds(tmp_path, monkeypatch):
    progress, realm, ids, _ = board_for(tmp_path)
    board = progress.board(current="b")
    assert board["cards"][0]["topic"] == "front-desk-b" and board["cards"][0]["current"]
    monkeypatch.setattr(panel, "MAX_CARDS", 1)
    board = progress.board(current="b", fresh=True)
    assert [c["topic"] for c in board["cards"]] == ["front-desk-b", "front-desk-a"][:len(board["cards"])]
    assert progress.board(current="nothing-here")["current_note"]


def test_a_board_is_reused_and_costs_no_zulip_call(tmp_path):
    progress, realm, ids, mirror = board_for(tmp_path)
    before = realm.calls
    first = progress.board()
    second = progress.board()
    assert first["generated_at"] == second["generated_at"] and progress.boards == 1
    assert realm.calls == before


def test_a_stale_mirror_marks_every_card_last_known(tmp_path):
    progress, realm, ids, mirror = board_for(tmp_path)
    mirror._set_stale("the event queue expired")
    board = progress.board(fresh=True)
    assert board["source"]["mirror"] == "stale"
    assert all(c["stale"] and c["reason"].startswith("last known") for c in board["cards"])


def test_a_new_post_is_seen_on_the_next_board_after_the_refresh_bound(tmp_path, monkeypatch):
    progress, realm, ids, mirror = board_for(tmp_path)
    assert card_of(progress.board(), "front-desk-b")["state"] == "answered"
    realm.post("front", "front-desk-b", "and task 2?", sender_id=DEV, sender_name="Developer", timestamp=BASE + 900)
    pump(mirror)
    # The mirror's revision moved: the cached board is not reused.
    assert card_of(progress.board(), "front-desk-b")["state"] == "queued"


def test_the_route_answers_and_writes_nothing(tmp_path):
    from agentroom.room import Room
    from agentroom.server import build_server

    progress, realm, ids, mirror = board_for(tmp_path)
    server = build_server("127.0.0.1", 0, Room(mirror=mirror), progress=progress)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        connection = HTTPConnection("127.0.0.1", server.server_address[1])
        connection.request("GET", "/progress?current=a")
        response = connection.getresponse()
        payload = json.loads(response.read())
        assert response.status == 200 and payload["cards"][0]["topic"] == "front-desk-a"
        assert payload["schema"] == "ag.progress-board.v1"
    finally:
        server.shutdown()
    assert [m for m in realm.messages.values() if m["id"] > max(ids.values()) + 10] == []


def _units(card):
    stack = [card["root"]]
    while stack:
        unit = stack.pop()
        yield unit
        stack.extend(unit["children"])


class QueueRunner(Runner):
    """Answers a queued post's probe with where it waits (failsafe p5)."""

    def __call__(self, command, **kwargs):
        if "--queued" not in command:
            return super().__call__(command, **kwargs)
        self.calls.append(command)
        return SimpleNamespace(stdout=json.dumps({
            "schema": "agag.health.v1", "observed_at": time.time(), "verdict": "queued",
            "why": "queued 40 s (position 1 of 1) behind work-m1/workrun-task1, whose serving is running",
            "subject": {"ack": 0, "queued": True},
            "queue": {"ahead": [{"channel": "work-m1", "topic": "workrun-task1", "ack": 1, "verdict": "running"}]}}),
            returncode=0)


def test_a_queued_post_of_a_probed_owner_shows_the_listeners_own_answer(tmp_path):
    def second(realm, say, ids):
        realm.add_channel(8, "pj-other")
        say("front", "front-desk-c", "plan the other thing", DEV, "Developer", "c")
        say("pj-other", "workplan-c", f"[selfnote][rootchat] front/front-desk-c #{ids['c']}", FRONT, "Front")
        say("pj-other", "workplan-c", "@**autolab** please plan the other thing", FRONT, "Front", "queued")

    runner = QueueRunner()
    progress, realm, ids, _ = board_for(tmp_path, runner, setup=second)
    card = card_of(progress.board(), "front-desk-c")
    plan = next(u for u in _units(card) if u["topic"] == "workplan-c")
    assert plan["display"]["state"] == "queued"
    assert plan["queue"]["state"] == "behind" and plan["queue"]["evidence"] == "confirmed"
    assert plan["queue"]["post"] == ids["queued"] and "behind work-m1/workrun-task1" in plan["display"]["reason"]
    queued = [c for c in runner.calls if "--queued" in c]
    assert len(queued) == 1 and queued[0][queued[0].index("--ack") + 1] == "0"
