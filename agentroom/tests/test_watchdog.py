"""robust_workflow p2 step 4: the relay tells a stopped, stuck or blind
request monitor apart from a healthy idle one, from the monitor's record
alone — the monitor never has to report its own failure."""

from __future__ import annotations

import json
from datetime import datetime, timezone

from agentroom.watchdog import SCHEMA, Watchdog, evaluate

NOW = 1_800_000_000.0


def record(**over) -> dict:
    base = {
        "schema": SCHEMA, "written_at": NOW - 10, "enabled": True, "interval_seconds": 120,
        "cycle": {"count": 7, "started_at": NOW - 11, "completed_at": NOW - 10, "in_progress": False,
                  "duration_seconds": 0.2},
        "source": {"state": "live", "stale_since": None},
        "requests": {"tracked": 3, "oldest_unchecked_seconds": 10, "open_incidents": 0},
        "judgment": {"running": None, "pending": 0, "timeout_seconds": 150},
        "latest_failure": None,
    }
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            base[key] = {**base[key], **value}
        else:
            base[key] = value
    return base


def polled(seconds_ago: float) -> dict:
    stamp = datetime.fromtimestamp(NOW - seconds_ago, timezone.utc).isoformat()
    return {"schema": "agag.status.v1", "last_poll_ok": stamp}


def test_healthy_and_idle():
    assert evaluate(record(), now=NOW)["state"] == "ok"
    assert evaluate(record(requests={"tracked": 0}), now=NOW)["state"] == "idle"


def test_missing_and_disabled_are_their_own_states():
    assert evaluate(None, now=NOW)["state"] == "missing"
    assert evaluate({"schema": SCHEMA, "enabled": False}, now=NOW)["state"] == "disabled"


def test_a_stopped_thread_in_a_live_process_is_named_as_such():
    quiet = record(cycle={"completed_at": NOW - 600, "started_at": NOW - 601})
    alive = evaluate(quiet, polled(20), now=NOW)
    assert alive["state"] == "stopped" and alive["listener_alive"] is True
    assert "the monitor alone is not moving" in alive["reason"]
    down = evaluate(quiet, polled(900), now=NOW)
    assert down["state"] == "stopped" and down["listener_alive"] is False and "process is down" in down["reason"]


def test_a_cycle_that_never_finishes_is_stalled():
    stuck = record(cycle={"in_progress": True, "started_at": NOW - 500})
    assert evaluate(stuck, now=NOW)["state"] == "stalled"
    assert evaluate(record(cycle={"in_progress": True, "started_at": NOW - 30}), now=NOW)["state"] == "ok"


def test_a_held_judgment_is_named_while_the_looks_go_on():
    held = record(judgment={"running": {"topic": "incident-silent-5", "since": NOW - 400}})
    found = evaluate(held, now=NOW)
    assert found["state"] == "judgment_stalled" and "incident-silent-5" in found["reason"]
    assert evaluate(record(judgment={"running": {"since": NOW - 100}}), now=NOW)["state"] == "ok"


def test_a_stale_source_is_unable_to_observe_and_unchecked_requests_are_degraded():
    stale = record(source={"state": "stale", "stale_since": NOW - 400, "reason": "queue expired"})
    assert evaluate(stale, now=NOW)["state"] == "unable_to_observe"
    assert evaluate(record(source={"state": "stale", "stale_since": NOW - 60}), now=NOW)["state"] == "ok"
    assert evaluate(record(requests={"oldest_unchecked_seconds": 900}), now=NOW)["state"] == "degraded"


def test_a_judge_falling_behind_or_churning_evidence_is_degraded():
    """robust_workflow p3 step 2: a verdict is used only for the evidence it
    judged, so a backlog or evidence that keeps moving means nothing is being
    concluded on those requests — said, not hidden behind `ok`."""
    behind = evaluate(record(judgment={"pending": 3, "oldest_pending_seconds": 600}), now=NOW)
    assert behind["state"] == "degraded" and "falling behind" in behind["reason"]
    churn = evaluate(record(judgment={"churning": ["o100:n102"]}), now=NOW)
    assert churn["state"] == "degraded" and "o100:n102" in churn["reason"]
    assert evaluate(record(judgment={"pending": 1, "oldest_pending_seconds": 120, "churning": []}),
                    now=NOW)["state"] == "ok"


def test_one_alert_on_the_way_in_and_one_on_the_way_out(tmp_path):
    path = tmp_path / "monitor-health.json"
    sent = []
    clock = {"now": NOW}
    dog = Watchdog(path, alert=sent.append, clock=lambda: clock["now"], log=lambda line: None)
    path.write_text(json.dumps(record()))
    dog.check()
    assert sent == []
    clock["now"] += 600  # nothing written since: stopped
    dog.check()
    dog.check()
    assert len(sent) == 1 and "stopped" in sent[0]
    path.write_text(json.dumps(record(written_at=clock["now"],
                                      cycle={"completed_at": clock["now"], "started_at": clock["now"]})))
    dog.check()
    assert len(sent) == 2 and "ok again" in sent[1]
