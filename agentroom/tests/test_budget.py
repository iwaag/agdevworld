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
    assert "token expired" in card["error"] and "next claude_code run" in card["error"]
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
    board = Budget([claude, codex, AgyProvider()]).snapshot(NOW)
    assert board["schema"] == "ag.budget.v1" and board["generated_at"] == NOW
    assert set(board["harnesses"]) == {"claude_code", "codex", "agy"}
    assert board["harnesses"]["codex"]["ok"] is True
    assert board["harnesses"]["claude_code"]["ok"] is False
    assert board["harnesses"]["agy"]["ok"] is False
    # No provider ever answers 0 for "did not answer".
    for card in board["harnesses"].values():
        if not card["ok"]:
            assert card["windows"] == [] and card["error"]
