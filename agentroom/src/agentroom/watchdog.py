"""Who watches the watcher: the relay reads Observer's monitor-health record.

`robust_workflow` p2 step 4. Observer's request monitor finds stalls nobody
registered — and until now nothing found the monitor's own. It is a thread
in Observer's process: the process can be alive, its listener polling, and
the monitor stopped or stuck inside a 30–130 s local-model judgment, and
nothing said so (p1's "nobody watches the watcher"; nctl reported Observer
`unobserved`). A heartbeat the monitor sends itself cannot be the alarm for
the monitor having stopped.

So the monitor writes a small record every cycle
(`agobserver/.local/monitor-health.json`, schema
`agobserver.monitor-health.v1`) and this — a different process, always on,
already the operator's board — reads it. The verdict is deterministic, from
the record's own clock (same host, so no skew) and Observer's listener status
file:

| state | meaning |
|---|---|
| `ok` / `idle` | cycles are completing on schedule; `idle` when nothing is tracked |
| `disabled` | switched off (`AGOBSERVER_MONITOR=0`) — said, not alarmed |
| `missing` | no record: never ran here, or the file is gone |
| `stopped` | no cycle in progress and none completed for `3 × interval + 60 s` — the thread is gone (the process too, when the listener stopped polling) |
| `stalled` | a cycle in progress for that long |
| `judgment_stalled` | one judgment running for twice its timeout |
| `unable_to_observe` | the monitor's source (its mirror) stale for 5 min |
| `degraded` | some tracked request not looked at for `3 × interval`; or a judgment waiting longer than `3 × timeout` behind others; or an incident whose evidence changed under its judgment `CHURN_LIMIT` times in a row (robust_workflow p3 step 2) |

On a change into a failing state, and on the way back, the relay tells the
realm's owners once by a direct message from its own bot — the one kind of
post it makes outside `#ops-testbed`, to humans only, never naming an agent
(`AGENTROOM_MONITOR_ALERT=dm`; unset, the board and `/healthz` show it and
nothing is sent).
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable

HEALTH_VARIABLE = "AGENTROOM_MONITOR_HEALTH"
STATUS_VARIABLE = "AGENTROOM_MONITOR_STATUS"
ALERT_VARIABLE = "AGENTROOM_MONITOR_ALERT"
SCHEMA = "agobserver.monitor-health.v1"
EVERY_SECONDS = 30.0
SOURCE_STALE_SECONDS = 300.0
LISTENER_STALE_SECONDS = 300.0
FAILING = ("missing", "stopped", "stalled", "judgment_stalled", "unable_to_observe", "degraded")

__all__ = ["Watchdog", "evaluate"]


def _read(path: Path | None) -> dict | None:
    if path is None:
        return None
    try:
        found = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return found if isinstance(found, dict) else None


def _age(now: float, then) -> float | None:
    try:
        return max(0.0, now - float(then)) if then else None
    except (TypeError, ValueError):
        return None


def _minutes(seconds: float | None) -> str:
    if seconds is None:
        return "an unknown time"
    return f"{seconds:.0f} s" if seconds < 90 else f"{seconds / 60:.0f} min"


def _listener(status: dict | None, now: float) -> tuple[bool | None, str]:
    """Whether Observer's listener polled recently (`agag-status.json`)."""
    if not status:
        return None, "its listener status is not readable"
    stamp = str(status.get("last_poll_ok") or "").replace("Z", "+00:00")
    try:
        polled = datetime.fromisoformat(stamp).timestamp()
    except ValueError:
        return None, "its listener status carries no poll time"
    age = now - polled
    if age > LISTENER_STALE_SECONDS:
        return False, f"its listener has not polled for {_minutes(age)} either — the process is down"
    return True, "its listener is polling, so the process is alive and the monitor alone is not moving"


def evaluate(health: dict | None, status: dict | None = None, now: float | None = None) -> dict:
    """The monitor's condition from its record, as one state and a reason."""
    now = time.time() if now is None else now
    if not health or health.get("schema") != SCHEMA:
        return {"state": "missing", "reason": "no monitor-health record: the monitor has not run here, "
                                              "or its record is gone", "checked_at": now}
    if health.get("enabled") is False:
        return {"state": "disabled", "reason": "the request monitor is switched off", "checked_at": now}
    interval = float(health.get("interval_seconds") or 120)
    limit = 3 * interval + 60
    cycle = health.get("cycle") or {}
    base = {"checked_at": now, "interval_seconds": interval, "cycle": cycle,
            "requests": health.get("requests") or {}, "judgment": health.get("judgment") or {},
            "latest_failure": health.get("latest_failure"), "source": health.get("source") or {}}
    if cycle.get("in_progress"):
        running = _age(now, cycle.get("started_at"))
        if running is not None and running > limit:
            return {**base, "state": "stalled", "since": cycle.get("started_at"),
                    "reason": f"a monitoring cycle has been running for {_minutes(running)} "
                              f"(cycles are every {_minutes(interval)})"}
    else:
        quiet = _age(now, cycle.get("completed_at") or health.get("written_at"))
        if quiet is None or quiet > limit:
            alive, why = _listener(status, now)
            return {**base, "state": "stopped", "since": cycle.get("completed_at"), "listener_alive": alive,
                    "reason": f"no monitoring cycle for {_minutes(quiet)}; {why}"}
    judgment = (health.get("judgment") or {}).get("running") or {}
    timeout = float((health.get("judgment") or {}).get("timeout_seconds") or 150)
    held = _age(now, judgment.get("since"))
    if held is not None and held > 2 * timeout:
        return {**base, "state": "judgment_stalled", "since": judgment.get("since"),
                "reason": f"the judgment of {judgment.get('topic', '?')} has run for {_minutes(held)} "
                          f"(its timeout is {_minutes(timeout)}); other requests are still looked at"}
    source = health.get("source") or {}
    if source.get("state") not in (None, "live"):
        stale = _age(now, source.get("stale_since")) or _age(now, health.get("written_at")) or 0.0
        if stale > SOURCE_STALE_SECONDS or source.get("stale_since") is None:
            return {**base, "state": "unable_to_observe", "since": source.get("stale_since"),
                    "reason": f"the monitor's copy of the realm is {source.get('state')} "
                              f"({source.get('reason') or 'no reason given'}); it concludes nothing and asks nobody"}
    unchecked = float((health.get("requests") or {}).get("oldest_unchecked_seconds") or 0)
    if unchecked > limit:
        return {**base, "state": "degraded",
                "reason": f"a tracked request has not been looked at for {_minutes(unchecked)}"}
    judgments = health.get("judgment") or {}
    waiting = float(judgments.get("oldest_pending_seconds") or 0)
    if waiting > 3 * timeout:
        return {**base, "state": "degraded",
                "reason": f"{judgments.get('pending')} judgment(s) waiting, the oldest for {_minutes(waiting)}: "
                          "the judge is falling behind"}
    churning = list(judgments.get("churning") or [])
    if churning:
        return {**base, "state": "degraded",
                "reason": f"the evidence under {len(churning)} judgment(s) keeps changing before a verdict can be "
                          f"used ({', '.join(churning[:3])}); nothing is concluded on them meanwhile"}
    tracked = int((health.get("requests") or {}).get("tracked") or 0)
    return {**base, "state": "ok" if tracked else "idle",
            "reason": f"cycle {cycle.get('count')} completed {_minutes(_age(now, cycle.get('completed_at')))} ago; "
                      f"{tracked} request(s) tracked"}


@dataclass
class Watchdog:
    """Re-evaluates the record every `EVERY_SECONDS` and alerts on change."""

    health_path: Path
    status_path: Path | None = None
    alert: Callable[[str], None] | None = None
    clock: Callable[[], float] = time.time
    log: Callable[[str], None] = print
    _latest: dict = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def check(self) -> dict:
        found = evaluate(_read(self.health_path), _read(self.status_path), self.clock())
        with self._lock:
            before = self._latest.get("state")
            self._latest = found
        state = found["state"]
        if before != state:
            self.log(f"watchdog: Observer's request monitor is {state}: {found['reason']}")
            was_failing, failing = before in FAILING, state in FAILING
            if self.alert is not None and before is not None and (failing or was_failing):
                text = (f"**Observer's request monitor is {state.replace('_', ' ')}.** {found['reason']}."
                        if failing else
                        f"Observer's request monitor is {state} again ({found['reason']}).")
                try:
                    self.alert(text)
                except Exception as error:  # noqa: BLE001 - the board still shows it
                    self.log(f"watchdog: could not send the alert: {error!r}")
            elif self.alert is not None and before is None and failing:
                try:
                    self.alert(f"**Observer's request monitor is {state.replace('_', ' ')}** (found when the "
                               f"relay started). {found['reason']}.")
                except Exception as error:  # noqa: BLE001
                    self.log(f"watchdog: could not send the alert: {error!r}")
        return found

    def latest(self) -> dict:
        with self._lock:
            return dict(self._latest) or self.check()

    def run(self, stop: threading.Event | None = None) -> None:
        stop = stop or threading.Event()
        while not stop.is_set():
            try:
                self.check()
            except Exception as error:  # noqa: BLE001 - the watchdog outlives its checks
                self.log(f"watchdog: check failed: {error!r}")
            stop.wait(EVERY_SECONDS)


def dm_owners(client_factory: Callable[[], object]) -> Callable[[str], None]:
    """An alert sent as a direct message to the realm's owners (humans)."""

    def send(text: str) -> None:
        client = client_factory()
        owners = sorted(int(u) for u in client.realm_owners())
        if owners:
            client.send_dm(owners, text)

    return send
