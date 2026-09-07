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
import re
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable

BUDGET_SCHEMA = "ag.budget.v1"
#: Seconds a provider's answer is held before the vendor is asked again.
BUDGET_SECONDS_VARIABLE = "AGENTROOM_BUDGET_SECONDS"
DEFAULT_BUDGET_SECONDS = 60.0
#: Claude Code's own credentials file, read-only. Never the values themselves.
CLAUDE_CREDENTIALS_VARIABLE = "AGENTROOM_CLAUDE_CREDENTIALS"
DEFAULT_CLAUDE_CREDENTIALS = "~/.claude/.credentials.json"
#: On macOS the CLI's *live* store is a Keychain item, not the file: measured
#: 2026-09-07, the item's mdat was 20:55 JST while the file sat at 13:08 with a
#: token that expired at 21:08 — through which a Front run served fine. Read
#: the item first (`security find-generic-password -w`, read-only), the file
#: after. Set to an empty string to skip the Keychain.
CLAUDE_KEYCHAIN_VARIABLE = "AGENTROOM_CLAUDE_KEYCHAIN"
DEFAULT_CLAUDE_KEYCHAIN = "Claude Code-credentials" if sys.platform == "darwin" else ""
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
#: How long `/budget` waits for its providers before answering with what it has.
JOIN_SECONDS = 15.0
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

    def last_good(self) -> dict | None:
        return dict(self._good) if self._good else None

    def snapshot(self, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        with self._lock:
            if self._cached is not None and now - self._cached_at < self.ttl_seconds:
                return dict(self._cached)
            try:
                found = self.read()
                found.setdefault("ok", True)
            except (RuntimeError, TimeoutError) as error:
                # The provider's own words: it said what went wrong.
                found = {"ok": False, "error": str(error)}
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


def _keychain_read(service: str, timeout: float = 5.0) -> tuple[str, float | None]:
    """`(secret, modified_at)` of a generic-password item, through `security`.

    Two read-only calls: `-w` for the value, the attribute listing for
    `mdat` (`"mdat"<timedate>=0x… "20260907115534Z\000"`). Nothing is added,
    changed or deleted.
    """
    def run(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(  # noqa: S603 - fixed tool, fixed verbs
            ["security", "find-generic-password", "-s", service, *args],
            capture_output=True, text=True, timeout=timeout, check=False,
        )
    try:
        secret = run("-w")
    except FileNotFoundError:
        raise RuntimeError("no `security` tool on this host") from None
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"`security` gave no answer within {timeout:g}s") from None
    if secret.returncode != 0:
        text = (secret.stderr or secret.stdout).strip().splitlines()
        raise RuntimeError(f"keychain item {service!r}: " + (text[-1] if text else f"exit {secret.returncode}"))
    modified = None
    try:
        attributes = run()
        found = re.search(r'"mdat"<timedate>=0x[0-9A-Fa-f]+\s+"(\d{14})Z', attributes.stdout)
        if found:
            modified = datetime.strptime(found.group(1) + "+0000", "%Y%m%d%H%M%S%z").timestamp()
    except (subprocess.SubprocessError, OSError, ValueError):
        modified = None
    return secret.stdout.strip(), modified


CLAUDE_LABELS = {
    "session": "5-hour session",
    "weekly_all": "weekly, all models",
    "weekly_scoped": "weekly",
}


@dataclass
class ClaudeProvider(Provider):
    """Read the plan's windows with Claude Code's own access token. Read-only."""

    credentials: Path = field(default_factory=lambda: Path(DEFAULT_CLAUDE_CREDENTIALS).expanduser())
    keychain: str = DEFAULT_CLAUDE_KEYCHAIN
    fetch: Callable[[str, dict[str, str], float], tuple[int, bytes]] = _http_get
    keychain_read: Callable[[str], tuple[str, float | None]] = _keychain_read
    harness: str = "claude_code"
    source: str = "api.anthropic.com/api/oauth/usage"

    def _store(self) -> tuple[dict, float | None, str, str | None]:
        """`(doc, renewed_at, store, keychain_error)`: the Keychain item first, the file after."""
        keychain_error = None
        if self.keychain:
            try:
                text, modified = self.keychain_read(self.keychain)
                return json.loads(text), modified, "keychain", None
            except (RuntimeError, ValueError) as error:
                keychain_error = str(error)
        try:
            doc = json.loads(self.credentials.read_text(encoding="utf-8"))
            return doc, self.credentials.stat().st_mtime, "file", keychain_error
        except FileNotFoundError:
            reason = f"no credentials file at {self.credentials.name}"
        except (OSError, ValueError) as error:
            reason = f"credentials file unreadable: {type(error).__name__}: {error}"
        if keychain_error:
            reason = f"{keychain_error}; and {reason}"
        raise RuntimeError(reason + " — has Claude Code logged in on this host?")

    def read(self) -> dict:
        doc, renewed_at, store, keychain_error = self._store()
        oauth = doc.get("claudeAiOauth") if isinstance(doc, dict) else None
        if not isinstance(oauth, dict) or not oauth.get("accessToken"):
            raise RuntimeError(f"the {store} credentials carry no claude.ai OAuth token (an API-key "
                               "login has no plan window to read)")
        where = self.keychain if store == "keychain" else self.credentials.name
        base = {
            "plan": str(oauth.get("subscriptionType") or "unknown"),
            "tier": oauth.get("rateLimitTier"),
            "store": store,
            "keychain_error": keychain_error,
            "credential_renewed_at": renewed_at,
            "token_expires_at": _epoch(oauth.get("expiresAt")),
            "note": "cost_usd on claude_code records is the API-equivalent price, not money "
                    "leaving an account: a Max plan meters these windows, not dollars.",
        }
        expires = base["token_expires_at"]
        if expires is not None and expires <= time.time():
            # Measured 2026-09-07: a Front run on this binary completed while
            # the file's token was 3 minutes expired and did *not* rewrite the
            # file — so the file is not necessarily the store the CLI runs
            # on (macOS keeps a Keychain item too). Say what is known: this
            # file, expired since when, and that only the CLI renews it.
            renewed = (time.strftime('%H:%M', time.localtime(renewed_at)) if renewed_at else "unknown")
            return {**base, "ok": False,
                    "error": f"access token in {where} expired at "
                             f"{time.strftime('%H:%M', time.localtime(expires))} ({store} renewed "
                             f"{renewed}); only a Claude Code login or token refresh rewrites it "
                             "— the relay never does"}
        status, body = self.fetch(CLAUDE_USAGE_URL, {
            "Authorization": f"Bearer {oauth['accessToken']}",
            "anthropic-beta": CLAUDE_BETA,
            "Accept": "application/json",
        }, READ_TIMEOUT_SECONDS)
        if status == 401:
            return {**base, "ok": False,
                    "error": "401 from the usage endpoint — token expired or revoked; only a "
                             "Claude Code login or token refresh rewrites the file, the relay never does"}
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


# --- agy: Antigravity's own /usage and /credits, headless -------------------------


AGY_USAGE_ARGS = ("-p", "/usage", "--mode", "plan", "--output-format", "json", "--print-timeout", "60s")
AGY_CREDITS_ARGS = ("-p", "/credits", "--mode", "plan", "--output-format", "json", "--print-timeout", "60s")
#: /usage took 7.6 s wall on agstudio (2026-09-07), so this one gets its own.
AGY_TIMEOUT_SECONDS = 30.0


def _run_cli(binary: str, args: tuple[str, ...], timeout: float) -> tuple[int, str, str]:
    """`(returncode, stdout, stderr)` of one CLI call; the caller reads the JSON."""
    try:
        done = subprocess.run(  # noqa: S603 - the binary is configured, the args fixed
            [binary, *args], capture_output=True, text=True, timeout=timeout, check=False,
        )
    except FileNotFoundError:
        raise RuntimeError(f"agy binary not found: {binary}") from None
    except subprocess.TimeoutExpired:
        raise TimeoutError(f"agy gave no answer within {timeout:g}s") from None
    return done.returncode, done.stdout, done.stderr


def _agy_reply(binary: str, args: tuple[str, ...], run, timeout: float) -> dict:
    """The CLI's JSON envelope, or the reason it is not one, in the CLI's own words."""
    code, out, err = run(binary, args, timeout)
    try:
        doc = json.loads(out)
    except ValueError:
        text = (out or err).strip()
        raise RuntimeError(f"agy exited {code} without JSON" + (f": {text[-200:]}" if text else "")) from None
    if not isinstance(doc, dict):
        raise RuntimeError("agy answered something that is not an object")
    status = doc.get("status")
    if status != "SUCCESS":
        text = str(doc.get("response") or doc.get("error") or "").strip()
        raise RuntimeError(f"agy answered {status or 'no status'}" + (f": {text[:200]}" if text else ""))
    command = doc.get("command")
    if not isinstance(command, dict) or not isinstance(command.get("data"), dict):
        # The slash command did not expand into data — the TUI shows
        # "[Auth Needed]" in this state; whatever the CLI said is the reason.
        text = str(doc.get("response") or "").strip()
        raise RuntimeError("agy answered without a command block (logged out?)"
                           + (f": {text[:200]}" if text else ""))
    return command["data"]


AGY_WINDOW_LABELS = {"weekly": "weekly", "5h": "5-hour"}


@dataclass
class AgyProvider(Provider):
    """`/usage` — a weekly and a 5-hour window per model *group*, as used percent.

    Antigravity reports `remaining_fraction`; the meter is `1 − remaining`
    so the three harnesses read the same way. `/credits` is the purchasable
    pool, a different thing: one footer line, only when non-zero. `--mode
    plan` so nothing needs the permission bypass; the CLI does its own OAuth
    and the relay opens no token file.
    """

    binary: str = DEFAULT_AGY_BIN
    run: Callable[[str, tuple[str, ...], float], tuple[int, str, str]] = _run_cli
    timeout_seconds: float = AGY_TIMEOUT_SECONDS
    harness: str = "agy"
    source: str = "agy -p /usage --mode plan --output-format json"

    def read(self) -> dict:
        data = _agy_reply(self.binary, AGY_USAGE_ARGS, self.run, self.timeout_seconds)
        windows: list[dict] = []
        for group in data.get("groups") or []:
            if not isinstance(group, dict):
                continue
            name = str(group.get("name") or "models")
            for bucket in group.get("buckets") or []:
                if not isinstance(bucket, dict):
                    continue
                remaining = bucket.get("remaining_fraction")
                percent = round((1.0 - float(remaining)) * 100.0, 1) if isinstance(remaining, (int, float)) else None
                window = str(bucket.get("window") or "window")
                windows.append(_window(
                    str(bucket.get("id") or f"{name}-{window}"),
                    f"{name}, {AGY_WINDOW_LABELS.get(window, window)}", percent,
                    _iso_to_epoch(bucket.get("reset_time")),
                    scope=name, window_kind=window, description=bucket.get("description"),
                ))
        if not windows:
            raise RuntimeError("agy /usage answered without groups[].buckets[]")
        found = {"plan": "consumer", "windows": windows, "note": None,
                 "remaining_credits": None, "upgrade_uri": None, "credits_error": None}
        try:
            credits = _agy_reply(self.binary, AGY_CREDITS_ARGS, self.run, self.timeout_seconds)
            value = credits.get("remaining_credits")
            found["remaining_credits"] = float(value) if isinstance(value, (int, float)) else None
            found["upgrade_uri"] = credits.get("upgrade_uri")
        except (RuntimeError, TimeoutError) as error:
            # The meters stand on their own; the footer says the pool is unknown.
            found["credits_error"] = str(error)
        return found


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
        deadline = time.monotonic() + JOIN_SECONDS
        for thread in threads:
            # Bounded: the page's own fetch times out, and a provider still
            # reading keeps its thread, finishes, and fills its cache for the
            # next tick. Until then its card says it is still reading — not 0.
            thread.join(max(deadline - time.monotonic(), 0.0))
        harnesses = {}
        for provider in self.providers:
            harnesses[provider.harness] = found.get(provider.harness) or {
                "harness": provider.harness, "source": provider.source, "ok": False,
                "read_at": now, "windows": [], "stale": provider.last_good(),
                "error": f"still reading after {JOIN_SECONDS:g}s; the next poll will have it",
            }
        return {
            "schema": BUDGET_SCHEMA,
            "generated_at": now,
            "harnesses": harnesses,
            "settings": {"cache_seconds": self.providers[0].ttl_seconds if self.providers else None,
                         "read_timeout_seconds": READ_TIMEOUT_SECONDS, "join_seconds": JOIN_SECONDS},
        }


def budget_from_env() -> Budget:
    """The three providers, configured from the environment (paths only, never values)."""
    ttl = float(os.environ.get(BUDGET_SECONDS_VARIABLE, DEFAULT_BUDGET_SECONDS))
    credentials = Path(os.environ.get(CLAUDE_CREDENTIALS_VARIABLE) or DEFAULT_CLAUDE_CREDENTIALS).expanduser()
    keychain = os.environ.get(CLAUDE_KEYCHAIN_VARIABLE, DEFAULT_CLAUDE_KEYCHAIN)
    codex_bin = os.path.expanduser(os.environ.get(CODEX_BIN_VARIABLE) or DEFAULT_CODEX_BIN)
    agy_bin = os.path.expanduser(os.environ.get(AGY_BIN_VARIABLE) or DEFAULT_AGY_BIN)
    return Budget([
        ClaudeProvider(credentials=credentials, keychain=keychain, ttl_seconds=ttl),
        CodexProvider(binary=codex_bin, ttl_seconds=ttl),
        AgyProvider(binary=agy_bin, ttl_seconds=ttl),
    ])
