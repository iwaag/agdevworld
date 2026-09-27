"""The progress panel's read: every request in flight, as cards.

`progress_panel` p1 step 2. The Front Room shows, beside a conversation,
the requests going on in *any* Front conversation: their plans, tasks and
runs, what is advancing, what waits, whose move it is. This module is that
read on the relay; `agag.progress` is the interpretation, so any other
reader that shows progress says the same thing.

**Where the facts come from, and what each costs:**

- **The conversations** — `agag.trace` over the relay's mirror
  (`MirrorReader`): no Zulip call. A board is computed at most every
  `REFRESH_SECONDS`; a browser polling faster is answered from memory.
- **Execution health** — only for owners Observer probes: the same
  `health.toml` and the same command (`agag.health.v1`), run here for an
  **open serving** only, matched by its ack, at most every `PROBE_TTL`
  seconds per serving, all due probes side by side within `PROBE_BUDGET`.
  A probe reads a directory, the process table and a journal; it starts
  nothing. Every other owner is conversation-only and the card says so.
- **Recovery** — Observer's own files (`incidents/*.json`, `held.json`,
  `retired.json`, `tracked.json`), read as they are: an incident, a hold
  by a person, a retirement. Nothing here writes them.

**Which requests** (step 1): `#front`'s `front-*` conversations, by their
first post (`o<id>`, Observer's key) —

- *active*: not ✔ with activity within `ACTIVE_HOURS`, or anything below
  it unfinished by record, or tracked/held by Observer;
- *recent results*: finished within `RECENT_HOURS`, at most `RECENT_MAX`;
- at most `MAX_CARDS`, newest activity first; the conversation the viewer
  has open (`current`) is always included and pinned.

**Nothing here is live when the source is not.** A stale mirror marks every
card `stale` and keeps the last-known state visible as last known. Showing
or hiding the panel controls nothing: no route here writes, starts a run or
touches Observer.
"""

from __future__ import annotations

import json
import subprocess
import threading
import time
import tomllib
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from agag.agent import is_ack
from agag.outstanding import read_requests
from agag.progress import SCHEMA as CARD_SCHEMA
from agag.progress import card as build_card
from agag.trace import MirrorReader, trace
from agag.zulip import RESOLVED_TOPIC_PREFIX

SCHEMA = "ag.progress-board.v1"
ORIGIN_CHANNEL = "front"
ORIGIN_PREFIX = "front-"
DESK_PREFIX = "front-desk-"
ACTIVE_HOURS = 12.0
RECENT_HOURS = 24.0
RECENT_MAX = 6
MAX_CARDS = 16
#: How long a computed board is reused. The mirror is local; the bound is
#: what keeps a panel polling every few seconds from re-tracing each time.
REFRESH_SECONDS = 5.0
#: How long a probe of one serving is reused, and the look's whole budget.
PROBE_TTL = 15.0
PROBE_BUDGET = 5.0
PROBE_WORKERS = 8
#: A request older than this is not looked at at all unless something keeps
#: it (Observer, an unfinished unit found last time): the trace is cheap,
#: but not free, and the realm keeps weeks of `front-*` conversations.
SCAN_HOURS = 72.0

__all__ = ["Progress", "ObserverRecords", "HealthChecks", "progress_from_env"]


# --- Observer's records -------------------------------------------------------------


@dataclass
class ObserverRecords:
    """Observer's state files, read-only. Missing files are "nothing
    recorded"; unreadable ones are said in `problems`."""

    directory: Path | None

    def read(self) -> dict[str, Any]:
        found: dict[str, Any] = {"available": False, "incidents": [], "held": {}, "retired": {}, "tracked": {},
                                 "problems": [], "monitor": None}
        if self.directory is None:
            found["problems"].append("Observer's directory is not configured")
            return found
        incidents = self.directory / "incidents"
        if not incidents.is_dir():
            found["problems"].append(f"{incidents.name}/ is not there")
            return found
        found["available"] = True
        for name in ("held", "retired", "tracked"):
            path = incidents / f"{name}.json"
            try:
                found[name] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
            except (OSError, ValueError) as error:
                found["problems"].append(f"{path.name}: {error}")
        for path in incidents.glob("*.json"):
            if path.stem in ("held", "retired", "tracked", "health", "reviews", "monitor-state", "episodes") \
                    or "~" in path.stem:
                continue
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(record, dict) and record.get("key"):
                found["incidents"].append(record)
        try:
            found["monitor"] = json.loads((self.directory / "monitor-health.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            found["monitor"] = None
        return found


OPEN_INCIDENT_STATES = ("detected", "recovering")


def recovery_for(records: dict[str, Any], origin: int) -> dict[int, dict]:
    """`{unit anchor: recovery}` for one request: its incidents by the
    stalled node's anchor, a hold or retirement on its origin."""
    okey = f"o{int(origin)}"
    found: dict[int, dict] = {}
    for record in records.get("incidents", []):
        if (record.get("origin") or {}).get("key") != okey:
            continue
        anchor = int((record.get("node") or {}).get("anchor") or 0)
        state = str(record.get("state") or "")
        entry = {
            "incident": record.get("key"), "kind": record.get("kind"), "state": state,
            # `detected`/`recovering` are live; `reported` without a later
            # "moving again" is a stop the owners were told about and nobody
            # has recovered; `dismissed` is a wait judged legitimate.
            "open": state in OPEN_INCIDENT_STATES,
            "unrecovered": state == "reported" and not record.get("cleared_at"),
            "fact": record.get("fact"), "responsible": record.get("responsible"),
            "detected_at": record.get("detected_at"), "topic": record.get("topic"),
        }
        current = found.get(anchor)
        if current is None or (entry["open"] and not current.get("open")) \
                or float(entry.get("detected_at") or 0) > float(current.get("detected_at") or 0):
            found[anchor] = entry
    held = (records.get("held") or {}).get(okey)
    retired = (records.get("retired") or {}).get(okey)
    if held or retired:
        root = found.setdefault(int(origin), {})
        if held:
            root.update(held=True, held_why=(held or {}).get("why") if isinstance(held, dict) else str(held))
        if retired:
            root.update(retired=True, retired_why=(retired or {}).get("why") if isinstance(retired, dict) else "")
    return found


# --- health checks -------------------------------------------------------------------


@dataclass
class HealthChecks:
    """Observer's probe configuration and the same command, for open
    servings only, cached per (owner, ack)."""

    config: Path | None
    runner: Callable[..., Any] = subprocess.run
    clock: Callable[[], float] = time.time
    _cache: dict[tuple[str, int], tuple[float, dict]] = field(default_factory=dict, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    runs: int = 0

    def owners(self) -> dict[str, dict]:
        if self.config is None or not self.config.is_file():
            return {}
        try:
            data = tomllib.loads(self.config.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return {str(name): dict(entry) for name, entry in (data.get("owners") or {}).items()
                if isinstance(entry, dict) and entry.get("command")}

    def covers(self, owner: str) -> bool:
        return owner in self.owners()

    def _run(self, entry: dict, owner: str, ack: int, channel: str, topic: str) -> dict:
        command = [*map(str, entry["command"]), "--ack", str(ack), "--channel", channel, "--topic", topic]
        timeout = float(entry.get("timeout") or 10)
        try:
            done = self.runner(command, capture_output=True, text=True, timeout=timeout)
            report = json.loads(done.stdout)
            if not isinstance(report, dict):
                raise ValueError("not a document")
            return report
        except Exception as error:  # noqa: BLE001 - a probe answers, never raises
            return {"schema": "agag.health.v1", "observed_at": self.clock(), "verdict": "unknown",
                    "why": f"the health probe of {owner} failed: {type(error).__name__}", "subject": {"ack": ack},
                    "unknowns": [str(error)[:200]]}

    def check(self, jobs: list[tuple[str, int, str, str]]) -> dict[tuple[str, int], dict]:
        """`{(owner, ack): report}` for these open servings: cached ones as
        they are, the rest probed side by side within the budget."""
        owners = self.owners()
        now = self.clock()
        answers: dict[tuple[str, int], dict] = {}
        due = []
        with self._lock:
            for owner, ack, channel, topic in jobs:
                if owner not in owners or not ack:
                    continue
                cached = self._cache.get((owner, ack))
                if cached is not None and now - cached[0] < PROBE_TTL:
                    answers[(owner, ack)] = cached[1]
                else:
                    due.append((owner, ack, channel, topic))
        if not due:
            return answers
        pool = ThreadPoolExecutor(max_workers=min(PROBE_WORKERS, len(due)), thread_name_prefix="progress-probe")
        futures = {pool.submit(self._run, owners[o], o, a, c, t): (o, a) for o, a, c, t in due}
        done, late = wait(futures, timeout=PROBE_BUDGET)
        pool.shutdown(wait=False, cancel_futures=True)
        with self._lock:
            for future in done:
                key = futures[future]
                answers[key] = future.result()
                self._cache[key] = (self.clock(), answers[key])
                self.runs += 1
            for key in (futures[f] for f in late):
                answers.setdefault(key, {"verdict": "unknown", "observed_at": self.clock(), "subject": {"ack": key[1]},
                                         "why": f"the probe did not answer within {PROBE_BUDGET:g} s"})
            # Forget servings nobody asked about for a while.
            for key in [k for k, (at, _) in self._cache.items() if now - at > 20 * PROBE_TTL]:
                self._cache.pop(key, None)
        return answers


# --- the board -------------------------------------------------------------------------


@dataclass
class Progress:
    ops: Any
    observer: ObserverRecords
    health: HealthChecks
    viewer: Callable[[], int | None] = lambda: None
    clock: Callable[[], float] = time.time
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _cached: tuple[float, int, dict] | None = field(default=None, repr=False)
    #: Requests found unfinished by an earlier board: kept in scope however
    #: old their last post is, until a board finds them finished.
    _keep: set[int] = field(default_factory=set, repr=False)
    #: The last card per origin, for "last known" when the source is lost.
    _last: dict[int, dict] = field(default_factory=dict, repr=False)
    boards: int = 0

    @property
    def mirror(self):
        return self.ops.mirror if self.ops is not None else None

    def board(self, current: str | None = None, *, fresh: bool = False) -> dict:
        now = self.clock()
        mirror = self.mirror
        if mirror is None:
            return {"schema": SCHEMA, "generated_at": now, "error": "the relay holds no mirror", "cards": []}
        revision = mirror.store.revision()
        with self._lock:
            cached = self._cached
        if cached is not None and not fresh and now - cached[0] < REFRESH_SECONDS and cached[1] == revision:
            board = cached[2]
        else:
            board = self._compute(now)
            with self._lock:
                self._cached = (now, revision, board)
        return self._with_current(board, current, now)

    # -- which requests -----------------------------------------------------------

    def _origins(self, now: float, records: dict) -> list[dict]:
        """Every `front-*` conversation with a reason to be looked at."""
        mirror = self.mirror
        tracked = {int(k[1:]) for k in (records.get("tracked") or {}) if str(k).startswith("o") and k[1:].isdigit()}
        held = {int(k[1:]) for k in (records.get("held") or {}) if str(k).startswith("o") and k[1:].isdigit()}
        seen: dict[int, dict] = {}
        for index in mirror.topics(ORIGIN_CHANNEL, include_resolved=True):
            if not index.name.startswith(ORIGIN_PREFIX):
                continue
            messages = mirror.messages(ORIGIN_CHANNEL, index.name)
            if not messages:
                continue
            first, last = messages[0], messages[-1]
            origin = int(first.id)
            entry = seen.setdefault(origin, {"origin": origin, "topic": index.name, "resolved": True,
                                             "first_at": int(first.timestamp or 0), "last_at": 0, "live": index.live_name})
            entry["resolved"] = entry["resolved"] and index.resolved
            if not index.resolved:
                entry["live"] = index.live_name
            entry["last_at"] = max(entry["last_at"], int(last.timestamp or 0))
        found = []
        for origin, entry in seen.items():
            age = now - entry["last_at"]
            keep = origin in self._keep or origin in tracked or origin in held
            if age > SCAN_HOURS * 3600 and not keep:
                continue
            entry["tracked"] = origin in tracked
            entry["held"] = origin in held
            entry["kept"] = keep
            found.append(entry)
        return found

    # -- one computation ------------------------------------------------------------

    def _compute(self, now: float) -> dict:
        mirror = self.mirror
        health = mirror.health()
        live = health.get("state") == "live"
        records = self.observer.read()
        reader = MirrorReader(mirror)
        viewer = self.viewer()
        results = []
        for entry in self._origins(now, records):
            result = trace(reader, entry["origin"], now=int(now))
            results.append((entry, result))
        # Probes: the open servings of probed owners, all at once.
        jobs = []
        owners = self.health.owners()
        for _, result in results:
            for node in result.nodes():
                if node.execution == "open" and node.owner in owners and node.ack:
                    jobs.append((node.owner, int(node.ack), node.channel, node.topic))
        reports = self.health.check(jobs) if jobs else {}
        cards = []
        for entry, result in results:
            by_anchor = {int(n.anchor): reports[(n.owner, int(n.ack))] for n in result.nodes()
                         if (n.owner, int(n.ack or 0)) in reports}
            pending = []
            if result.root is not None:
                history = mirror.history(ORIGIN_CHANNEL, entry["topic"], num_before=400)
                outstanding = read_requests(history, complete=len(history) < 400, closed=entry["resolved"],
                                            is_ack=is_ack)
                pending = [{"id": r.id, "to": r.to, "to_name": r.to_name, "ask": r.ask, "at": r.timestamp}
                           for r in outstanding.pending]
            card = build_card(result, now=int(now), health=by_anchor,
                              recovery=recovery_for(records, entry["origin"]), viewer_id=viewer, pending=pending,
                              source_live=live, source_note=health.get("reason") or "")
            card.update(self._placement(entry, card, now))
            cards.append(card)
        cards = self._scope(cards, now)
        for card in cards:
            self._last[card["origin"]] = card
        self.boards += 1
        return {
            "schema": SCHEMA, "card_schema": CARD_SCHEMA, "generated_at": now, "observed_at": int(now),
            "source": {"mirror": health.get("state"), "reason": health.get("reason"),
                       "last_event_at": health.get("last_event_at"), "revision": health.get("revision")},
            "observer": {"available": records["available"], "problems": records["problems"],
                         "monitor": _monitor_summary(records.get("monitor"), now)},
            "health": {"owners": sorted(owners), "probes_run": self.health.runs,
                       "note": "only these owners expose execution health; every other owner is read from its "
                               "conversation alone" if owners else "no owner exposes execution health here"},
            "bounds": {"active_hours": ACTIVE_HOURS, "recent_hours": RECENT_HOURS, "recent_max": RECENT_MAX,
                       "max_cards": MAX_CARDS, "refresh_seconds": REFRESH_SECONDS, "probe_ttl": PROBE_TTL},
            "cards": cards,
        }

    def _placement(self, entry: dict, card: dict, now: float) -> dict:
        topic = entry["topic"]
        desk = topic[len(DESK_PREFIX):] if topic.startswith(DESK_PREFIX) else None
        unfinished = card["state"] not in ("completed", "cancelled", "answered")
        if unfinished:
            self._keep.add(entry["origin"])
        else:
            self._keep.discard(entry["origin"])
        if unfinished or entry["held"] or (entry["tracked"] and card["state"] != "completed"):
            group = "active"
        else:
            group = "recent"
        return {
            "topic": topic, "live_topic": entry["live"], "resolved": entry["resolved"],
            "desk": desk, "group": group, "last_at": entry["last_at"], "first_at": entry["first_at"],
            "observer_tracked": entry["tracked"], "observer_held": entry["held"],
            "links": self._links(card),
        }

    def _scope(self, cards: list[dict], now: float) -> list[dict]:
        active = [c for c in cards if c["group"] == "active"
                  and (not c["resolved"] or c["state"] not in ("answered",))
                  and (now - c["last_at"] <= ACTIVE_HOURS * 3600 or c["origin"] in self._keep
                       or c["observer_tracked"] or c["observer_held"])]
        recent = [c for c in cards if c["group"] == "recent" and now - c["last_at"] <= RECENT_HOURS * 3600]
        recent.sort(key=lambda c: c["last_at"], reverse=True)
        active.sort(key=lambda c: c["last_at"], reverse=True)
        chosen = active + recent[:RECENT_MAX]
        return chosen[:MAX_CARDS]

    def _with_current(self, board: dict, current: str | None, now: float) -> dict:
        """The board with the viewer's conversation pinned first, looked up
        whatever the bounds left out."""
        cards = list(board.get("cards") or [])
        out = {**board, "current": current, "served_at": now}
        if not current:
            out["cards"] = cards
            return out
        topic = f"{DESK_PREFIX}{current}"
        mine = [c for c in cards if c["topic"] == topic]
        if not mine:
            found = self._one(topic, now)
            mine = [found] if found is not None else []
        rest = [c for c in cards if c["topic"] != topic]
        for card in mine:
            card["current"] = True
        out["cards"] = mine + rest
        if not mine:
            out["current_note"] = "this conversation has no post yet, so it is not a request"
        return out

    def _one(self, topic: str, now: float) -> dict | None:
        mirror = self.mirror
        messages = mirror.messages(ORIGIN_CHANNEL, topic)
        if not messages:
            return None
        records = self.observer.read()
        origin = int(messages[0].id)
        result = trace(MirrorReader(mirror), origin, now=int(now))
        health = mirror.health()
        card = build_card(result, now=int(now), recovery=recovery_for(records, origin), viewer_id=self.viewer(),
                          source_live=health.get("state") == "live", source_note=health.get("reason") or "")
        index = [t for t in mirror.topic(ORIGIN_CHANNEL, topic)]
        entry = {"origin": origin, "topic": topic, "resolved": all(t.resolved for t in index) if index else False,
                 "first_at": int(messages[0].timestamp or 0), "last_at": int(messages[-1].timestamp or 0),
                 "live": mirror.live_name(ORIGIN_CHANNEL, topic) or topic, "tracked": False, "held": False}
        card.update(self._placement(entry, card, now))
        card["group"] = "current"
        return card

    # -- links ------------------------------------------------------------------------

    def _links(self, card: dict) -> dict:
        """A Zulip link per unit (its evidence post), by anchor."""
        mirror = self.mirror
        base = getattr(mirror, "base_url", "") or ""
        links: dict[str, str] = {}
        if not base or card.get("root") is None:
            return links

        def walk(unit: dict) -> None:
            channel = mirror.channel(unit["channel"])
            if channel is not None:
                near = unit.get("evidence_id") or unit["anchor"]
                links[str(unit["anchor"])] = (f"{base}/#narrow/channel/{channel.stream_id}-{quote(unit['channel'], safe='')}"
                                              f"/topic/{quote(unit['topic'], safe='')}/near/{near}")
            for child in unit["children"]:
                walk(child)

        walk(card["root"])
        return links


def _monitor_summary(record: dict | None, now: float) -> dict:
    if not record:
        return {"state": "missing", "reason": "Observer's monitor-health record is not there"}
    cycle = record.get("cycle") or {}
    completed = float(cycle.get("completed_at") or 0)
    interval = float(record.get("interval_seconds") or 60)
    age = now - completed if completed else None
    state = "ok" if age is not None and age <= 3 * interval else "stale"
    return {"state": state, "cycle_age": round(age) if age is not None else None, "interval": interval,
            "reason": (f"Observer's last look ended {round(age)} s ago" if age is not None
                       else "Observer has not completed a look")}


def progress_from_env(ops, viewer: Callable[[], int | None], environ=None) -> Progress:
    """Observer's directory from `AGENTROOM_OBSERVER_DIR`, else the parent
    of `AGENTROOM_MONITOR_HEALTH` (its `monitor-health.json`), which the
    relay's watchdog already reads — so the deployed plist needs nothing new."""
    import os

    environ = os.environ if environ is None else environ
    directory = environ.get("AGENTROOM_OBSERVER_DIR", "")
    if not directory and environ.get("AGENTROOM_MONITOR_HEALTH"):
        directory = str(Path(environ["AGENTROOM_MONITOR_HEALTH"]).expanduser().parent)
    root = Path(directory).expanduser() if directory else None
    config = root / "health.toml" if root is not None else None
    return Progress(ops=ops, observer=ObserverRecords(root), health=HealthChecks(config), viewer=viewer)
