"""How much of each harness's *budget window* is used — read from the CLIs.

`/cost` says what runs cost; it cannot say how much room is left, because for
the subscription-style backends the agents actually use the vendor meters a
window, not a dollar: Claude Max (claude_code), ChatGPT Plus (codex) and
Antigravity on a consumer Google account (agy). Each CLI turns out to have a
way to read that window, and this module is one *provider* per harness:

- `claude_code` — `GET api.anthropic.com/api/oauth/usage` with the access
  token Claude Code keeps in its own credentials file. The same read the
  TUI's `/usage` makes. `limits[]` is what is rendered.
- `codex` — `codex app-server` over stdio JSON-RPC, `account/rateLimits/read`
  after `initialize`/`initialized`. The only headless read: `codex exec
  "/status"` sends the text to the model as a prompt and bills for it.
- `agy` — `agy -p /usage --mode plan --output-format json`, a slash command
  that answers locally (step 3 of `gauge_panel` ex1).

Three invariants, the same two the rest of the relay keeps and one of its own:

1. **Nothing here reads Zulip**, so `/budget` may be polled; the per-provider
   cache (`AGENTROOM_BUDGET_SECONDS`, default 60) is what limits vendor calls,
   not the page.
2. **An absence is *unknown*, never 0 or 100.** A provider that could not
   read answers `ok: false` with the reason and, when it has them, its last
   good numbers under `stale` — marked as such, never as the state now.
3. **The relay reads the CLIs' own credential stores and never writes them.**
   Refreshing a token is the CLI's job; on 401 the claude provider says the
   token expired and that the next claude_code run renews it. It never uses
   the refresh token. A store this relay had rewritten would be a CLI that
   stops logging in.

Each provider has its own cache, its own lock and its own failure: a codex
process that hangs does not blank the Claude card.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

BUDGET_SCHEMA = "ag.budget.v1"
#: Seconds a provider's answer is held before the vendor is asked again.
BUDGET_SECONDS_VARIABLE = "AGENTROOM_BUDGET_SECONDS"
DEFAULT_BUDGET_SECONDS = 60.0
#: Claude Code's own credentials file, read-only. Never the values themselves.
CLAUDE_CREDENTIALS_VARIABLE = "AGENTROOM_CLAUDE_CREDENTIALS"
DEFAULT_CLAUDE_CREDENTIALS = "~/.claude/.credentials.json"
CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CLAUDE_BETA = "oauth-2025-04-20"
#: The codex binary. It lives in `~/.local/bin` on agstudio, which the launchd
#: PATH does not carry, so the plist passes the absolute path.
CODEX_BIN_VARIABLE = "AGENTROOM_CODEX_BIN"
DEFAULT_CODEX_BIN = "codex"
#: The Antigravity binary, likewise (step 3).
AGY_BIN_VARIABLE = "AGENTROOM_AGY_BIN"
DEFAULT_AGY_BIN = "~/.local/bin/agy"
#: How long one vendor read may take before it is *unknown*.
READ_TIMEOUT_SECONDS = 15.0
HARNESSES = ("claude_code", "codex", "agy")

__all__ = [
    "BUDGET_SCHEMA", "Budget", "ClaudeProvider", "CodexProvider", "AgyProvider",
    "Provider", "budget_from_env",
]


# --- helpers -------------------------------------------------------------------


def _iso_to_epoch(text) -> float | None:
    """`2026-09-07T15:19:59+00:00` (or `…Z`) → epoch seconds; None when unreadable."""
    if not isinstance(text, str) or not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _epoch(value) -> float | None:
    """A vendor's epoch (seconds, or milliseconds when it is plainly one) → seconds."""
    if not isinstance(value, (int, float)):
        return None
    return float(value) / 1000.0 if value > 10_000_000_000 else float(value)


def _window(kind: str, label: str, percent, resets_at: float | None, **extra) -> dict:
    """One meter. `percent` is *used* of the window, as the vendor said it."""
    return {
        "kind": kind, "label": label,
        "percent": float(percent) if isinstance(percent, (int, float)) else None,
        "resets_at": resets_at, **extra,
    }


# --- the provider shape -------------------------------------------------------


@dataclass
class Provider:
    """One harness's read, cached on its own clock with its own last-good copy."""

    harness: str
    source: str
    ttl_seconds: float = DEFAULT_BUDGET_SECONDS
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _cached: dict | None = field(default=None, repr=False)
    _cached_at: float = field(default=0.0, repr=False)
    _good: dict | None = field(default=None, repr=False)

    def read(self) -> dict:  # pragma: no cover - overridden
        """Return the harness payload; raise to report *unknown* with the message."""
        raise NotImplementedError

    def snapshot(self, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        with self._lock:
            if self._cached is not None and now - self._cached_at < self.ttl_seconds:
                return dict(self._cached)
            try:
                found = self.read()
                found.setdefault("ok", True)
            except Exception as error:  # noqa: BLE001 - the reason is the payload
                found = {"ok": False, "error": f"{type(error).__name__}: {error}"}
            payload = {"harness": self.harness, "source": self.source, "read_at": now, **found}
            if payload["ok"]:
                payload.setdefault("error", None)
                self._good = {k: v for k, v in payload.items() if k not in ("ok", "error")}
            else:
                # The last thing that *was* read, kept apart from the failure so
                # a card can grey it rather than draw the failure as 0.
                payload.setdefault("windows", [])
                payload["stale"] = dict(self._good) if self._good else None
            self._cached, self._cached_at = payload, now
            return dict(payload)


# --- claude_code: Claude Max through the OAuth usage endpoint -------------------


def _http_get(url: str, headers: dict[str, str], timeout: float) -> tuple[int, bytes]:
    """`(status, body)`; a non-2xx answer is returned, not raised."""
    import urllib.error
    import urllib.request

    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed https URL
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


CLAUDE_LABELS = {
    "session": "5-hour session",
    "weekly_all": "weekly, all models",
    "weekly_scoped": "weekly",
}


@dataclass
class ClaudeProvider(Provider):
    """Read the plan's windows with Claude Code's own access token. Read-only."""

    credentials: Path = field(default_factory=lambda: Path(DEFAULT_CLAUDE_CREDENTIALS).expanduser())
    fetch: Callable[[str, dict[str, str], float], tuple[int, bytes]] = _http_get
    harness: str = "claude_code"
    source: str = "api.anthropic.com/api/oauth/usage"

    def read(self) -> dict:
        try:
            doc = json.loads(self.credentials.read_text(encoding="utf-8"))
            renewed_at = self.credentials.stat().st_mtime
        except FileNotFoundError:
            raise RuntimeError(f"no credentials file at {self.credentials.name} — "
                               "has Claude Code logged in on this host?") from None
        except (OSError, ValueError) as error:
            raise RuntimeError(f"credentials unreadable: {type(error).__name__}: {error}") from None
        oauth = doc.get("claudeAiOauth") if isinstance(doc, dict) else None
        if not isinstance(oauth, dict) or not oauth.get("accessToken"):
            raise RuntimeError("credentials carry no claude.ai OAuth token (an API-key login "
                               "has no plan window to read)")
        base = {
            "plan": str(oauth.get("subscriptionType") or "unknown"),
            "tier": oauth.get("rateLimitTier"),
            "credential_renewed_at": renewed_at,
            "token_expires_at": _epoch(oauth.get("expiresAt")),
            "note": "cost_usd on claude_code records is the API-equivalent price, not money "
                    "leaving an account: a Max plan meters these windows, not dollars.",
        }
        expires = base["token_expires_at"]
        if expires is not None and expires <= time.time():
            return {**base, "ok": False,
                    "error": "access token expired; the next claude_code run refreshes it "
                             "(the relay never uses the refresh token)"}
        status, body = self.fetch(CLAUDE_USAGE_URL, {
            "Authorization": f"Bearer {oauth['accessToken']}",
            "anthropic-beta": CLAUDE_BETA,
            "Accept": "application/json",
        }, READ_TIMEOUT_SECONDS)
        if status == 401:
            return {**base, "ok": False,
                    "error": "401 from the usage endpoint — token expired; the next claude_code "
                             "run refreshes it (the relay never uses the refresh token)"}
        if status != 200:
            raise RuntimeError(f"usage endpoint answered {status}: {body[:200].decode('utf-8', 'replace')}")
        try:
            usage = json.loads(body)
        except ValueError:
            raise RuntimeError("usage endpoint answered something that is not JSON") from None
        windows = self._windows(usage)
        if not windows:
            raise RuntimeError("usage endpoint answered without limits[] or the named windows")
        extra = usage.get("extra_usage") if isinstance(usage.get("extra_usage"), dict) else {}
        return {**base, "windows": windows,
                "extra_usage": {"enabled": bool(extra.get("is_enabled"))} if extra else None}

    @staticmethod
    def _windows(usage: dict) -> list[dict]:
        """`limits[]` first — the named top-level fields repeat it with fixed names
        beside experiment keys that come and go, so they are only the fallback."""
        found: list[dict] = []
        limits = usage.get("limits")
        if isinstance(limits, list):
            for limit in limits:
                if not isinstance(limit, dict) or "percent" not in limit:
                    continue
                kind = str(limit.get("kind") or limit.get("group") or "window")
                scope = limit.get("scope")
                model = None
                if isinstance(scope, dict) and isinstance(scope.get("model"), dict):
                    model = scope["model"].get("display_name") or scope["model"].get("id")
                label = CLAUDE_LABELS.get(kind, kind.replace("_", " "))
                if model:
                    label = f"{label}, {model}"
                found.append(_window(kind, label, limit.get("percent"),
                                     _iso_to_epoch(limit.get("resets_at")),
                                     severity=limit.get("severity"), scope=model))
            if found:
                return found
        for key, kind, label in (("five_hour", "session", CLAUDE_LABELS["session"]),
                                 ("seven_day", "weekly_all", CLAUDE_LABELS["weekly_all"])):
            block = usage.get(key)
            if isinstance(block, dict) and "utilization" in block:
                found.append(_window(kind, label, block.get("utilization"),
                                     _iso_to_epoch(block.get("resets_at")), severity=None, scope=None))
        return found


# --- codex: ChatGPT Plus through the app-server protocol -----------------------


CODEX_REQUESTS = (
    {"jsonrpc": "2.0", "id": 1, "method": "initialize",
     "params": {"clientInfo": {"name": "agentroom", "version": "0.1.0"}}},
    {"jsonrpc": "2.0", "method": "initialized", "params": {}},
    {"jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read", "params": {}},
)


def _app_server(binary: str, requests: tuple[dict, ...], want_id: int, timeout: float) -> dict:
    """Send the requests and return the reply with `id == want_id`.

    stdin stays open until the reply arrives: closing it first makes the
    app-server exit before answering (measured). The process is killed after
    — a fresh one per read is simpler than a daemon and cannot go stale.
    """
    try:
        process = subprocess.Popen(  # noqa: S603 - the binary is configured, the args fixed
            [binary, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )
    except FileNotFoundError:
        raise RuntimeError(f"codex binary not found: {binary}") from None
    lines: queue.Queue[str | None] = queue.Queue()

    def pump() -> None:
        try:
            for line in process.stdout:  # type: ignore[union-attr]
                lines.put(line)
        finally:
            lines.put(None)

    threading.Thread(target=pump, daemon=True).start()
    deadline = time.monotonic() + timeout
    try:
        for request in requests:
            process.stdin.write(json.dumps(request) + "\n")  # type: ignore[union-attr]
        process.stdin.flush()  # type: ignore[union-attr]
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"codex app-server gave no reply within {timeout:g}s")
            try:
                line = lines.get(timeout=remaining)
            except queue.Empty:
                raise TimeoutError(f"codex app-server gave no reply within {timeout:g}s") from None
            if line is None:
                err = (process.stderr.read() if process.stderr else "").strip()  # type: ignore[union-attr]
                raise RuntimeError("codex app-server exited before answering"
                                   + (f": {err[-300:]}" if err else ""))
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if isinstance(message, dict) and message.get("id") == want_id:
                if "error" in message:
                    detail = message["error"]
                    text = detail.get("message") if isinstance(detail, dict) else str(detail)
                    raise RuntimeError(f"codex app-server refused: {text}")
                return message.get("result") or {}
    finally:
        try:
            process.kill()
        except OSError:
            pass


def _codex_kind(minutes) -> str:
    if minutes == 300:
        return "5h"
    if minutes == 10080:
        return "weekly"
    if isinstance(minutes, (int, float)):
        return f"{int(minutes)}m"
    return "window"


@dataclass
class CodexProvider(Provider):
    """`account/rateLimits/read`: the plan's two windows, plus the reset credits."""

    binary: str = DEFAULT_CODEX_BIN
    talk: Callable[[str, tuple[dict, ...], int, float], dict] = _app_server
    harness: str = "codex"
    source: str = "codex app-server account/rateLimits/read"

    def read(self) -> dict:
        result = self.talk(self.binary, CODEX_REQUESTS, 2, READ_TIMEOUT_SECONDS)
        limits = result.get("rateLimits") if isinstance(result, dict) else None
        if not isinstance(limits, dict):
            raise RuntimeError("app-server answered without rateLimits")
        windows: list[dict] = []
        for key, fallback in (("primary", "5-hour"), ("secondary", "weekly")):
            block = limits.get(key)
            if not isinstance(block, dict):
                continue
            kind = _codex_kind(block.get("windowDurationMins"))
            label = {"5h": "5-hour session", "weekly": "weekly"}.get(kind, fallback)
            windows.append(_window(kind, label, block.get("usedPercent"),
                                   _epoch(block.get("resetsAt")),
                                   window_minutes=block.get("windowDurationMins")))
        if not windows:
            raise RuntimeError("app-server answered rateLimits without primary/secondary windows")
        credits = limits.get("credits") if isinstance(limits.get("credits"), dict) else {}
        resets = result.get("rateLimitResetCredits") if isinstance(result.get("rateLimitResetCredits"), dict) else {}
        listed = [c for c in (resets.get("credits") or []) if isinstance(c, dict)]
        expiring = [_iso_to_epoch(c.get("expiresAt")) or _epoch(c.get("expiresAt")) for c in listed]
        expiring = [stamp for stamp in expiring if stamp is not None]
        return {
            "plan": str(limits.get("planType") or "unknown"),
            "windows": windows,
            "reset_credits": {
                "available": resets.get("availableCount"),
                "expiring_at": min(expiring) if expiring else None,
                "titles": [str(c.get("title")) for c in listed if c.get("title")],
            },
            "credits": {
                "has": bool(credits.get("hasCredits")), "unlimited": bool(credits.get("unlimited")),
                "balance": credits.get("balance"),
            } if credits else None,
            "limit_reached": limits.get("rateLimitReachedType"),
            "spend_control_reached": bool(limits.get("spendControlReached")),
            "note": None,
        }


# --- agy: Antigravity, step 3 --------------------------------------------------


@dataclass
class AgyProvider(Provider):
    """Placeholder until step 3: honestly *unknown*, never 0."""

    binary: str = DEFAULT_AGY_BIN
    harness: str = "agy"
    source: str = "agy -p /usage --mode plan --output-format json"

    def read(self) -> dict:
        raise RuntimeError("the agy provider is not implemented yet (gauge_panel ex1 step 3)")


# --- the route's payload ---------------------------------------------------------


class Budget:
    """One provider per harness, each on its own cache; the vendors are asked in parallel."""

    def __init__(self, providers: list[Provider]) -> None:
        self.providers = list(providers)

    def snapshot(self, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        found: dict[str, dict] = {}
        threads = []
        for provider in self.providers:
            def run(one: Provider = provider) -> None:
                found[one.harness] = one.snapshot(now)
            thread = threading.Thread(target=run, daemon=True)
            thread.start()
            threads.append(thread)
        for thread in threads:
            # A little over the read timeout: a provider that hangs past it
            # is reported as such by its own error, not by blanking the rest.
            thread.join(READ_TIMEOUT_SECONDS + 2)
        harnesses = {}
        for provider in self.providers:
            harnesses[provider.harness] = found.get(provider.harness) or {
                "harness": provider.harness, "source": provider.source, "ok": False,
                "read_at": now, "windows": [], "stale": None,
                "error": "the provider did not answer in time",
            }
        return {
            "schema": BUDGET_SCHEMA,
            "generated_at": now,
            "harnesses": harnesses,
            "settings": {"cache_seconds": self.providers[0].ttl_seconds if self.providers else None,
                         "read_timeout_seconds": READ_TIMEOUT_SECONDS},
        }


def budget_from_env() -> Budget:
    """The three providers, configured from the environment (paths only, never values)."""
    ttl = float(os.environ.get(BUDGET_SECONDS_VARIABLE, DEFAULT_BUDGET_SECONDS))
    credentials = Path(os.environ.get(CLAUDE_CREDENTIALS_VARIABLE) or DEFAULT_CLAUDE_CREDENTIALS).expanduser()
    codex_bin = os.path.expanduser(os.environ.get(CODEX_BIN_VARIABLE) or DEFAULT_CODEX_BIN)
    agy_bin = os.path.expanduser(os.environ.get(AGY_BIN_VARIABLE) or DEFAULT_AGY_BIN)
    return Budget([
        ClaudeProvider(credentials=credentials, ttl_seconds=ttl),
        CodexProvider(binary=codex_bin, ttl_seconds=ttl),
        AgyProvider(binary=agy_bin, ttl_seconds=ttl),
    ])
