"""The cost gauge's rules, against records shaped like the real ones.

One fixture per harness, copied from records this host actually wrote on
2026-09-07, because the harnesses disagree on token key names and on whether
they say a price at all — and the gauge must never turn a silence into a 0.
"""

import json
import os
import time
from pathlib import Path

from agentroom.cost import Cost, normalize_usage, read_prices

NOW = 1_800_000_000.0

CLAUDE = {
    "schema": "ag.agent-run.v1", "request_id": "run-0007", "role": "front",
    "profile": "sonnet", "harness": "claude_code", "provider": "anthropic",
    "model": "anthropic/claude-sonnet-5", "duration_ms": 62790, "cost_usd": 0.259934,
    "usage": {"input_tokens": 26, "cache_creation_input_tokens": 14158,
              "cache_read_input_tokens": 479320, "output_tokens": 2007,
              "output_tokens_details": {"thinking_tokens": 224}},
    "num_turns": 13, "outcome": "done",
}
CODEX = {
    "schema": "ag.agent-run.v1", "request_id": "run-0545", "role": "front",
    "profile": "codex", "harness": "codex", "provider": "openai",
    "model": "openai/gpt-5.6-terra", "duration_ms": 16926, "num_turns": 2, "outcome": "done",
    "usage": {"input_tokens": 45720, "cached_input_tokens": 38144,
              "cache_write_input_tokens": 0, "output_tokens": 346, "reasoning_output_tokens": 62},
}
AGY = {
    "schema": "ag.agent-run.v1", "request_id": "run-0543", "role": "front",
    "profile": "agy", "harness": "agy", "provider": "antigravity",
    "model": "antigravity/gemini-3.8-flash-medium", "duration_ms": 20847,
    "num_turns": 1, "outcome": "done",
    "usage": {"input_tokens": 67337, "output_tokens": 2346, "thinking_tokens": 1862,
              "cache_read_tokens": 32496, "total_tokens": 69683},
}
GEMINI_FAILED = {
    "schema": "ag.agent-run.v1", "request_id": "run-0512", "role": "front",
    "profile": "gemini", "harness": "gemini_cli", "provider": "google",
    "model": "google/gemini-2.5-flash", "duration_ms": 733, "outcome": "failed",
    "failure": "gemini_cli exited 41: no output",
}
GEMINI_DONE = {
    **GEMINI_FAILED, "request_id": "run-0513", "outcome": "done",
    "usage": {"input_tokens": 1_000_000, "output_tokens": 100_000},
}
AGCODE = {
    "schema": "ag.agent-run.v1", "request_id": "run-0006", "role": "superdirector",
    "profile": "local", "harness": "agcode", "provider": "ollama",
    "model": "ollama/qwen3.6:35b-a3b-coding-nvfp4", "duration_ms": 29220,
    "num_turns": 6, "outcome": "done", "usage": {"input_tokens": 18338, "output_tokens": 2568},
}
OPENCODE = {
    "schema": "ag.agent-run.v1", "role": "front", "profile": "local",
    "harness": "opencode", "provider": "ollama", "model": "ollama/qwen3.6:35b-a3b-coding-nvfp4",
    "num_turns": 6, "cost_usd": 0.0, "duration_ms": 25299, "outcome": "failed",
    "usage": {"input": 48145, "output": 967, "reasoning": 0, "cache_read": 0, "cache_write": 0},
}

PRICES = {
    "harnesses": {"claude_code": "reported", "gemini_cli": "metered", "codex": "subscription",
                  "agy": "subscription", "agcode": "local", "opencode": "local"},
    "models": {"google/gemini-2.5-flash": {"input": 0.30, "cached_input": 0.075, "output": 2.50}},
}


def write(root: Path, role: str, number: int, doc: dict, *, at: float) -> Path:
    path = root / ".local" / "agent" / role / f"run-{number:04d}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")
    os.utime(path, (at, at))
    return path


def prices_file(tmp_path: Path, doc: dict = PRICES) -> Path:
    path = tmp_path / "prices.json"
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


def test_usage_is_read_into_one_quartet_per_harness():
    assert normalize_usage("claude_code", CLAUDE["usage"]) == {
        "input": 26, "cached_input": 479320, "cache_write": 14158, "output": 2007, "reasoning": 224,
    }
    # codex counts the cached part inside input_tokens; the quartet does not.
    assert normalize_usage("codex", CODEX["usage"]) == {
        "input": 45720 - 38144, "cached_input": 38144, "cache_write": 0, "output": 346, "reasoning": 62,
    }
    assert normalize_usage("agy", AGY["usage"])["cached_input"] == 32496
    assert normalize_usage("opencode", OPENCODE["usage"]) == {
        "input": 48145, "cached_input": 0, "cache_write": 0, "output": 967, "reasoning": 0,
    }
    assert normalize_usage("gemini_cli", None) is None


def test_each_harness_gets_its_kind_and_no_silence_becomes_zero(tmp_path):
    root = tmp_path / "front"
    write(root, "front", 1, CLAUDE, at=NOW - 10)
    write(root, "front", 2, CODEX, at=NOW - 20)
    write(root, "front", 3, AGY, at=NOW - 30)
    write(root, "front", 4, GEMINI_FAILED, at=NOW - 40)
    write(root, "front", 5, GEMINI_DONE, at=NOW - 50)
    write(root, "superdirector", 6, AGCODE, at=NOW - 60)
    write(root, "window", 7, OPENCODE, at=NOW - 70)
    cost = Cost({"front-x": root}, prices_file(tmp_path))
    rows = {row.request_id or row.role: row for row in cost.scan()["rows"]}

    assert (rows["run-0007"].cost_kind, rows["run-0007"].cost_usd) == ("reported", 0.259934)
    assert (rows["run-0545"].cost_kind, rows["run-0545"].cost_usd) == ("subscription", None)
    assert (rows["run-0543"].cost_kind, rows["run-0543"].cost_usd) == ("subscription", None)
    assert (rows["run-0512"].cost_kind, rows["run-0512"].cost_usd) == ("unknown", None)
    # 1M input at 0.30 + 100k output at 2.50 = 0.55, and it is *estimated*.
    assert (rows["run-0513"].cost_kind, rows["run-0513"].cost_usd) == ("estimated", 0.55)
    assert (rows["run-0006"].cost_kind, rows["run-0006"].cost_usd) == ("local", 0.0)
    assert (rows["window"].cost_kind, rows["window"].cost_usd) == ("local", 0.0)
    # Old records: end is the file's mtime, start is derived from duration.
    assert rows["run-0007"].ended_at == NOW - 10
    assert abs(rows["run-0007"].started_at - (NOW - 10 - 62.79)) < 0.01

    board = cost.board(now=NOW, roster=["front-x", "elsewhere-y"])
    total = board["totals"]["today"]
    assert total["runs"] == 7 and total["failed"] == 2
    assert total["usd_reported"] == 0.259934
    assert total["usd_estimated"] == 0.55
    assert total["kinds"] == {"reported": 1, "estimated": 1, "subscription": 2, "local": 2, "unknown": 1}
    assert board["missing"] == ["elsewhere-y"]
    assert board["roots"] == [{"instance": "front-x", "ok": True, "records": 7}]


def test_unpriced_metered_model_is_unknown_not_zero(tmp_path):
    root = tmp_path / "front"
    write(root, "front", 1, GEMINI_DONE, at=NOW)
    cost = Cost({"front-x": root}, prices_file(tmp_path, {"harnesses": {"gemini_cli": "metered"}, "models": {}}))
    row = cost.scan()["rows"][0]
    assert (row.cost_kind, row.cost_usd) == ("unknown", None)
    # And with no table at all, nothing is priced and the payload says why.
    bare = Cost({"front-x": root}, None)
    assert bare.board(now=NOW)["prices"]["error"] == "no price table configured"


def test_new_records_carry_their_conversation_and_old_ones_are_windowed(tmp_path):
    root = tmp_path / "front"
    new = {**CLAUDE, "request_id": "run-0002", "started_at": NOW - 100, "ended_at": NOW - 40,
           "channel": "front", "topic": "front-routine-x-1", "generation": 2}
    write(root, "front", 2, new, at=NOW)
    # An old record, with a generation directory whose span holds its end.
    old = {**CLAUDE, "request_id": "run-0001"}
    write(root, "front", 1, old, at=NOW - 500)
    workspace = root / ".local" / "topics" / "front" / "front-routine-x-1" / "1" / "front"
    workspace.mkdir(parents=True)
    (workspace / "chatlog.md").write_text("x")
    os.utime(workspace / "chatlog.md", (NOW - 560, NOW - 560))
    os.utime(workspace, (NOW - 560, NOW - 560))
    os.utime(workspace.parent, (NOW - 560, NOW - 560))
    # And one nobody can place.
    write(root, "front", 3, {**CLAUDE, "request_id": "run-0003"}, at=NOW - 5000)

    cost = Cost({"front-x": root}, prices_file(tmp_path))
    rows = {row.request_id: row for row in cost.scan()["rows"]}
    assert rows["run-0002"].attribution == "fields"
    assert (rows["run-0002"].started_at, rows["run-0002"].ended_at) == (NOW - 100, NOW - 40)
    assert rows["run-0001"].attribution == "window"
    assert (rows["run-0001"].channel, rows["run-0001"].topic, rows["run-0001"].generation) == (
        "front", "front-routine-x-1", 1)
    assert rows["run-0003"].attribution == "none"

    sessions = {"x": [{
        "topic": "front-routine-x-1", "stamp": "s", "fire": {"at": NOW - 600},
        "resolution": {"state": "open"},
        "nodes": [{"channel": "pj-x", "topic": "workplan-1"}],
    }]}
    board = cost.board(now=NOW, routine_sessions=sessions)
    session = board["routines"][0]["sessions"][0]
    assert session["runs"] == 2
    assert session["usd_reported"] == round(2 * 0.259934, 6)
    assert session["attribution"] == {"fields": 1, "window": 1}
    assert session["conversations"] == [
        {"channel": "front", "topic": "front-routine-x-1", "runs": 2},
        {"channel": "pj-x", "topic": "workplan-1", "runs": 0},
    ]
    assert board["unattributed"]["runs"] == 1


def test_scan_is_incremental_and_follows_the_price_file(tmp_path):
    root = tmp_path / "front"
    path = write(root, "front", 1, GEMINI_DONE, at=NOW)
    prices = prices_file(tmp_path)
    cost = Cost({"front-x": root}, prices)
    assert cost.scan()["rows"][0].cost_usd == 0.55
    # Same mtime: not re-read. New mtime: re-read.
    path.write_text(json.dumps({**GEMINI_DONE, "usage": {"input_tokens": 2_000_000, "output_tokens": 0}}))
    os.utime(path, (NOW, NOW))
    assert cost.scan()["rows"][0].cost_usd == 0.55
    os.utime(path, (NOW + 1, NOW + 1))
    assert cost.scan()["rows"][0].cost_usd == 0.6
    # A price edit reprices everything.
    prices.write_text(json.dumps({**PRICES, "models": {"google/gemini-2.5-flash": {"input": 1.0, "output": 1.0}}}))
    os.utime(prices, (time.time() + 5, time.time() + 5))
    assert cost.scan()["rows"][0].cost_usd == 2.0
    assert read_prices(tmp_path / "nope.json").error.startswith("FileNotFoundError")
