"""The budget read's rules, against the payloads the CLIs actually answered.

Fixtures are the three reads made from agstudio on 2026-09-07 (`gauge_panel`
ex1 plan). The rule under test is the same one `/cost` keeps: a read that did
not happen is *unknown*, never 0 or 100 — and the relay never touches the
CLIs' credential stores beyond reading them.
"""

import json
import os
import time
from pathlib import Path

from agentroom.budget import (
    AgyProvider, Budget, ClaudeProvider, CodexProvider, CLAUDE_BETA, CLAUDE_USAGE_URL,
)

NOW = 1_800_000_000.0

CLAUDE_USAGE = {
    "five_hour": {"utilization": 38.0, "resets_at": "2026-09-07T15:19:59+00:00"},
    "seven_day": {"utilization": 18.0, "resets_at": "2026-09-12T05:59:59+00:00"},
    "limits": [
        {"kind": "session", "group": "session", "percent": 38, "severity": "normal",
         "resets_at": "2026-09-07T15:19:59+00:00", "is_active": True},
        {"kind": "weekly_all", "group": "weekly", "percent": 18, "severity": "normal",
         "resets_at": "2026-09-12T05:59:59+00:00"},
        {"kind": "weekly_scoped", "group": "weekly", "percent": 28, "severity": "normal",
         "resets_at": "2026-09-12T05:59:59+00:00", "scope": {"model": {"display_name": "Fable"}}},
    ],
    "extra_usage": {"is_enabled": False},
    "seven_day_sonnet": None, "seven_day_opus": None,
    "nimbus_quill": {"utilization": 1}, "tangelo": None,
}
CODEX_RESULT = {
    "rateLimits": {
        "planType": "plus",
        "primary": {"usedPercent": 0, "windowDurationMins": 300, "resetsAt": 1788798478},
        "secondary": {"usedPercent": 0, "windowDurationMins": 10080, "resetsAt": 1789385278},
        "credits": {"hasCredits": False, "unlimited": False, "balance": "0"},
        "spendControlReached": False, "rateLimitReachedType": None,
    },
    "rateLimitResetCredits": {
        "availableCount": 3,
        "credits": [{"title": "Full reset (Weekly + 5 hr)", "status": "available",
                     "expiresAt": "2026-10-01T00:00:00Z"}],
    },
}


def credentials(tmp_path: Path, *, expires_in_ms: int = 3_000_000) -> Path:
    path = tmp_path / ".credentials.json"
    path.write_text(json.dumps({"claudeAiOauth": {
        "accessToken": "sk-ant-oat01-test", "refreshToken": "sk-ant-ort01-test",
        "expiresAt": int(time.time() * 1000) + expires_in_ms,
        "subscriptionType": "max", "rateLimitTier": "default_claude_max_5x",
    }}), encoding="utf-8")
    os.utime(path, (NOW - 300, NOW - 300))
    return path


def test_claude_renders_limits_as_windows_and_says_usd_is_notional(tmp_path):
    seen = {}

    def fetch(url, headers, timeout):
        seen.update(url=url, headers=headers)
        return 200, json.dumps(CLAUDE_USAGE).encode()

    path = credentials(tmp_path)
    before = path.read_bytes()
    card = ClaudeProvider(credentials=path, fetch=fetch).snapshot(NOW)
    assert seen["url"] == CLAUDE_USAGE_URL
    assert seen["headers"]["Authorization"] == "Bearer sk-ant-oat01-test"
    assert seen["headers"]["anthropic-beta"] == CLAUDE_BETA
    assert card["ok"] and card["plan"] == "max" and card["tier"] == "default_claude_max_5x"
    assert [(w["kind"], w["percent"], w["scope"]) for w in card["windows"]] == [
        ("session", 38.0, None), ("weekly_all", 18.0, None), ("weekly_scoped", 28.0, "Fable"),
    ]
    assert card["windows"][2]["label"] == "weekly, Fable"
    assert card["windows"][0]["resets_at"] == 1788794399.0  # 2026-09-07T15:19:59Z
    assert card["windows"][0]["severity"] == "normal"
    assert card["credential_renewed_at"] == NOW - 300
    assert "API-equivalent" in card["note"]
    assert card["extra_usage"] == {"enabled": False}
    # Read-only: the store is byte-for-byte what it was.
    assert path.read_bytes() == before


def test_claude_401_is_unknown_and_the_refresh_token_is_never_used(tmp_path):
    calls = []

    def fetch(url, headers, timeout):
        calls.append(headers)
        return 401, b'{"error":"expired"}'

    path = credentials(tmp_path)
    before = path.read_bytes()
    card = ClaudeProvider(credentials=path, fetch=fetch).snapshot(NOW)
    assert card["ok"] is False and card["windows"] == []
    assert "token expired" in card["error"] and "the relay never does" in card["error"]
    assert card["plan"] == "max" and card["credential_renewed_at"] == NOW - 300
    assert all("ort01" not in json.dumps(h) for h in calls)
    assert path.read_bytes() == before
    # A token the file itself says is expired is not even sent.
    stale = credentials(tmp_path, expires_in_ms=-1000)
    calls.clear()
    card = ClaudeProvider(credentials=stale, fetch=fetch).snapshot(NOW)
    assert card["ok"] is False and calls == [] and "expired" in card["error"]


def test_claude_without_a_store_is_unknown(tmp_path):
    card = ClaudeProvider(credentials=tmp_path / "missing.json",
                          fetch=lambda *a: (200, b"{}")).snapshot(NOW)
    assert card["ok"] is False and "no credentials file" in card["error"]
    assert card["stale"] is None and card["windows"] == []


def test_codex_reads_the_two_windows_through_the_app_server():
    seen = {}

    def talk(binary, requests, want_id, timeout):
        seen.update(binary=binary, methods=[r["method"] for r in requests], want=want_id)
        return CODEX_RESULT

    card = CodexProvider(binary="/x/codex", talk=talk).snapshot(NOW)
    assert seen == {"binary": "/x/codex", "want": 2,
                    "methods": ["initialize", "initialized", "account/rateLimits/read"]}
    assert card["ok"] and card["plan"] == "plus"
    assert [(w["kind"], w["percent"], w["resets_at"]) for w in card["windows"]] == [
        ("5h", 0.0, 1788798478.0), ("weekly", 0.0, 1789385278.0),
    ]
    assert card["reset_credits"]["available"] == 3
    assert card["reset_credits"]["titles"] == ["Full reset (Weekly + 5 hr)"]
    assert card["credits"] == {"has": False, "unlimited": False, "balance": "0"}
    assert card["source"].startswith("codex app-server")


def test_codex_no_reply_is_unknown_and_keeps_the_last_good_read_apart():
    answers = [CODEX_RESULT, TimeoutError("codex app-server gave no reply within 15s")]

    def talk(binary, requests, want_id, timeout):
        found = answers.pop(0)
        if isinstance(found, Exception):
            raise found
        return found

    provider = CodexProvider(binary="codex", talk=talk, ttl_seconds=60)
    good = provider.snapshot(NOW)
    assert good["ok"]
    # Within the cache: the same answer, no second spawn.
    assert provider.snapshot(NOW + 30) == good and answers == [answers[0]]
    # Past it: the failure, with the good read apart and marked as stale.
    card = provider.snapshot(NOW + 61)
    assert card["ok"] is False and "no reply" in card["error"]
    assert card["windows"] == [] and card["stale"]["windows"] == good["windows"]
    assert card["stale"]["read_at"] == NOW


def test_the_board_holds_one_card_per_harness_and_fails_each_alone():
    claude = ClaudeProvider(credentials=Path("/nonexistent/creds.json"),
                            fetch=lambda *a: (200, b"{}"))
    codex = CodexProvider(binary="codex", talk=lambda *a: CODEX_RESULT)
    def off(*a):
        raise RuntimeError("agy binary not found: /x/agy")

    board = Budget([claude, codex, AgyProvider(run=off)]).snapshot(NOW)
    assert board["schema"] == "ag.budget.v1" and board["generated_at"] == NOW
    assert set(board["harnesses"]) == {"claude_code", "codex", "agy"}
    assert board["harnesses"]["codex"]["ok"] is True
    assert board["harnesses"]["claude_code"]["ok"] is False
    assert board["harnesses"]["agy"]["ok"] is False
    # No provider ever answers 0 for "did not answer".
    for card in board["harnesses"].values():
        if not card["ok"]:
            assert card["windows"] == [] and card["error"]


# --- agy (step 3) -----------------------------------------------------------------

AGY_USAGE = {
    "conversation_id": "", "status": "SUCCESS", "duration_seconds": 0, "num_turns": 0,
    "response": "Gemini Models\tWeekly Limit Remaining\t99%\t2026-09-11T15:26:48Z\n",
    "usage": {"input_tokens": 0, "output_tokens": 0, "thinking_tokens": 0, "cache_read_tokens": 0, "total_tokens": 0},
    "command": {"name": "usage", "data": {"description": "Within each group…", "groups": [
        {"name": "Gemini Models", "description": "Models within this group: Gemini Flash, Gemini Pro",
         "buckets": [
             {"id": "gemini-weekly", "name": "Weekly Limit Remaining", "window": "weekly",
              "remaining_fraction": 0.9916509985923767, "reset_time": "2026-09-11T15:26:48Z",
              "description": "You have used some of your weekly limit, it will fully refresh in 4 days, 3 hours."},
             {"id": "gemini-5h", "name": "Five Hour Limit Remaining", "window": "5h",
              "remaining_fraction": 1, "reset_time": "2026-09-07T17:05:44Z"}]},
        {"name": "Claude and GPT models", "buckets": [
            {"id": "3p-weekly", "window": "weekly", "remaining_fraction": 1, "reset_time": "2026-09-14T12:05:44Z"},
            {"id": "3p-5h", "window": "5h", "remaining_fraction": 1, "reset_time": "2026-09-07T17:05:44Z"}]},
    ]}},
}
AGY_CREDITS = {
    "conversation_id": "", "status": "SUCCESS", "response": "Remaining credits\t0\n",
    "command": {"name": "credits", "data": {"remaining_credits": 0,
                                            "upgrade_uri": "https://antigravity.google/g1-upgrade"}},
}


def agy_run(usage=AGY_USAGE, credits=AGY_CREDITS):
    calls = []

    def run(binary, args, timeout):
        calls.append((binary, args))
        doc = usage if "/usage" in args else credits
        if isinstance(doc, Exception):
            raise doc
        return 0, json.dumps(doc) if isinstance(doc, dict) else doc, ""

    return run, calls


def test_agy_inverts_remaining_fraction_into_four_meters():
    run, calls = agy_run()
    card = AgyProvider(binary="/x/agy", run=run).snapshot(NOW)
    assert card["ok"] and card["plan"] == "consumer"
    assert calls[0][0] == "/x/agy" and "--mode" in calls[0][1] and "plan" in calls[0][1]
    assert [(w["kind"], w["percent"], w["label"]) for w in card["windows"]] == [
        ("gemini-weekly", 0.8, "Gemini Models, weekly"), ("gemini-5h", 0.0, "Gemini Models, 5-hour"),
        ("3p-weekly", 0.0, "Claude and GPT models, weekly"), ("3p-5h", 0.0, "Claude and GPT models, 5-hour"),
    ]
    assert card["windows"][0]["resets_at"] == 1789140408.0  # 2026-09-11T15:26:48Z
    assert card["windows"][0]["scope"] == "Gemini Models"
    assert card["remaining_credits"] == 0.0 and card["upgrade_uri"].startswith("https://")
    assert card["credits_error"] is None


def test_agy_non_success_or_missing_command_is_unknown_in_the_clis_words():
    run, _ = agy_run(usage={"status": "ERROR", "response": "[Auth Needed] sign in again"})
    card = AgyProvider(run=run).snapshot(NOW)
    assert card["ok"] is False and card["windows"] == []
    assert card["error"] == "agy answered ERROR: [Auth Needed] sign in again"

    run, _ = agy_run(usage={"status": "SUCCESS", "response": "Please log in"})
    card = AgyProvider(run=run).snapshot(NOW)
    assert card["ok"] is False and "without a command block" in card["error"] and "Please log in" in card["error"]

    run, _ = agy_run(usage=TimeoutError("agy gave no answer within 30s"))
    card = AgyProvider(run=run).snapshot(NOW)
    assert card["ok"] is False and card["error"] == "agy gave no answer within 30s"

    run, _ = agy_run(usage="not json at all")
    card = AgyProvider(run=run).snapshot(NOW)
    assert card["ok"] is False and "without JSON" in card["error"]


def test_agy_credits_failure_leaves_the_meters_standing():
    run, _ = agy_run(credits=TimeoutError("agy gave no answer within 30s"))
    card = AgyProvider(run=run).snapshot(NOW)
    assert card["ok"] and len(card["windows"]) == 4
    assert card["remaining_credits"] is None and "no answer" in card["credits_error"]


def test_a_slow_provider_says_so_and_never_answers_zero(monkeypatch):
    import threading
    import agentroom.budget as budget

    monkeypatch.setattr(budget, "JOIN_SECONDS", 0.05)
    gate = threading.Event()

    def slow(binary, args, timeout):
        gate.wait(2)
        return 0, json.dumps(AGY_USAGE if "/usage" in args else AGY_CREDITS), ""

    provider = AgyProvider(run=slow)
    board = Budget([provider]).snapshot(NOW)
    card = board["harnesses"]["agy"]
    assert card["ok"] is False and card["windows"] == [] and "still reading" in card["error"]
    gate.set()
    # The thread finishes and fills the cache: the next tick has the read.
    for _ in range(50):
        if provider.last_good():
            break
        time.sleep(0.02)
    assert Budget([provider]).snapshot(NOW + 1)["harnesses"]["agy"]["ok"] is True
