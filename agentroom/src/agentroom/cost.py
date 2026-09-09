"""What the agents' backends cost — read from this host's run records.

Every agentic run on this host leaves an `ag.agent-run.v1` record under
`<instance>/.local/agent/<role>/run-NNNN.json` (`devpolicy/agent_records.md`).
This module walks the same roots `/inflight` walks (`AGENTROOM_AGENT_ROOTS`),
normalizes one row per record, prices what can be priced, and folds the rows
into the aggregates the gauge page draws. Nothing here reads Zulip: the one
realm-side thing it wants — which conversations belong to a routine session —
it asks the ops engine for, and the engine answers from links it already
holds. So this may be polled at will.

Five kinds of cost, because the harnesses do not agree on what they tell:

- `reported` — the harness gave USD itself (claude_code's `total_cost_usd`).
- `estimated` — tokens × the price table (a metered API key with no USD in the
  record). Always shown apart from `reported`, never summed into it silently.
- `subscription` — the vendor meters the plan, not the run (Antigravity, and
  codex on a ChatGPT login). Tokens and runs are shown; **no USD is invented**.
- `local` — ollama on this network: zero, and said to be zero.
- `unknown` — a record with no usage at all (a run that died before the
  harness could count), or a metered model the table does not price.

A model missing from the price table is `unknown`, not 0. An instance in the
roster with no root on this host is *missing*, not quiet.
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

COST_SCHEMA = "ag.cost.v1"
#: Where the tracked default price table lives; `AGENTROOM_PRICES` overrides.
PRICES_VARIABLE = "AGENTROOM_PRICES"
DEFAULT_PRICES = Path(__file__).resolve().parents[2] / "prices.json"
#: Older records carry no `channel`/`topic`; their conversation is guessed
#: from the generation directory whose lifetime the run's end falls into.
WINDOW_SLACK_SECONDS = 30.0
DAYS = 14
RECENT = 40
KINDS = ("reported", "estimated", "subscription", "local", "unknown")
MILLION = 1_000_000.0

__all__ = ["COST_SCHEMA", "Cost", "Prices", "Row", "normalize_usage", "read_prices"]


# --- the price table ---------------------------------------------------------


@dataclass
class Prices:
    """`prices.json`: a kind per harness and USD per million tokens per model."""

    harnesses: dict[str, str] = field(default_factory=dict)
    models: dict[str, dict] = field(default_factory=dict)
    path: Path | None = None
    error: str | None = None

    def kind(self, harness: str | None) -> str:
        return self.harnesses.get(harness or "", "unknown")

    def price(self, model: str | None) -> dict | None:
        found = self.models.get(model or "")
        return found if isinstance(found, dict) else None

    def payload(self) -> dict:
        return {
            "path": str(self.path) if self.path else None,
            "ok": self.error is None,
            "error": self.error,
            "harnesses": dict(self.harnesses),
            "models": sorted(self.models),
        }


def read_prices(path: Path | None) -> Prices:
    if path is None:
        return Prices(error="no price table configured")
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return Prices(path=path, error=f"{type(error).__name__}: {error}")
    return Prices(
        harnesses={str(k): str(v) for k, v in (doc.get("harnesses") or {}).items()},
        models={str(k): v for k, v in (doc.get("models") or {}).items()},
        path=path,
    )


# --- one run, normalized -----------------------------------------------------


def normalize_usage(harness: str | None, usage: dict | None) -> dict | None:
    """The token quartet every harness can be read into, or None.

    `input` is the *uncached* prompt, `cached_input` what was served from a
    cache, `cache_write` what was written into one, `output` the completion
    (thinking included, where the harness counts it there). `reasoning` is
    informational: codex and agy report it beside `output`, claude inside it.
    """
    if not isinstance(usage, dict):
        return None
    get = lambda *keys: next((usage[k] for k in keys if isinstance(usage.get(k), (int, float))), 0)  # noqa: E731
    if harness == "codex":
        cached = get("cached_input_tokens")
        # codex's `input_tokens` includes the cached part.
        return {
            "input": max(get("input_tokens") - cached, 0), "cached_input": cached,
            "cache_write": get("cache_write_input_tokens"),
            "output": get("output_tokens"), "reasoning": get("reasoning_output_tokens"),
        }
    if harness == "opencode":
        return {
            "input": get("input"), "cached_input": get("cache_read"),
            "cache_write": get("cache_write"), "output": get("output"),
            "reasoning": get("reasoning"),
        }
    details = usage.get("output_tokens_details")
    thinking = details.get("thinking_tokens", 0) if isinstance(details, dict) else 0
    return {
        "input": get("input_tokens", "prompt_tokens"),
        "cached_input": get("cache_read_input_tokens", "cache_read_tokens", "cached_content_tokens"),
        "cache_write": get("cache_creation_input_tokens", "cache_write_tokens"),
        "output": get("output_tokens", "candidates_tokens", "completion_tokens"),
        "reasoning": get("thinking_tokens", "reasoning_tokens") or thinking,
    }


def _estimate(tokens: dict, price: dict) -> float | None:
    """USD from the quartet and a per-million table; None when the table is partial."""
    try:
        usd = tokens["input"] * float(price.get("input", 0)) / MILLION
        usd += tokens["cached_input"] * float(price.get("cached_input", price.get("input", 0))) / MILLION
        usd += tokens["cache_write"] * float(price.get("cache_write", price.get("input", 0))) / MILLION
        usd += tokens["output"] * float(price.get("output", 0)) / MILLION
    except (TypeError, ValueError):
        return None
    return round(usd, 6)


@dataclass
class Row:
    instance: str
    role: str
    path: str
    request_id: str | None
    harness: str | None
    provider: str | None
    model: str | None
    profile: str | None
    outcome: str
    started_at: float | None
    ended_at: float
    duration_ms: int | None
    num_turns: int | None
    tokens: dict | None
    cost_usd: float | None
    cost_kind: str
    channel: str | None
    topic: str | None
    generation: int | None
    attribution: str  # fields | window | none

    def payload(self) -> dict:
        return dict(self.__dict__)


def _row(instance: str, role: str, path: Path, doc: dict, prices: Prices) -> Row:
    harness = doc.get("harness")
    kind = prices.kind(harness)
    tokens = normalize_usage(harness, doc.get("usage"))
    reported = doc.get("cost_usd")
    cost: float | None = None
    if kind == "local":
        cost = 0.0
    elif isinstance(reported, (int, float)) and kind == "reported":
        cost = float(reported)
    elif kind in ("reported", "estimated", "metered"):
        # A metered run without USD in the record: price it if we can.
        price = prices.price(doc.get("model"))
        if tokens is not None and price is not None:
            cost, kind = _estimate(tokens, price), "estimated"
        else:
            kind = "unknown"
        if cost is None:
            kind = "unknown"
    elif kind == "subscription":
        cost = None
    else:
        kind = "unknown"
    if tokens is None and kind not in ("local",):
        # Nothing was counted: a launch failure, a harness that died first.
        kind, cost = "unknown", None
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = 0.0
    ended = doc.get("ended_at") if isinstance(doc.get("ended_at"), (int, float)) else mtime
    started = doc.get("started_at") if isinstance(doc.get("started_at"), (int, float)) else None
    duration = doc.get("duration_ms") if isinstance(doc.get("duration_ms"), int) else None
    if started is None and duration is not None:
        started = ended - duration / 1000.0
    channel = doc.get("channel") if isinstance(doc.get("channel"), str) else None
    topic = doc.get("topic") if isinstance(doc.get("topic"), str) else None
    generation = doc.get("generation") if isinstance(doc.get("generation"), int) else None
    return Row(
        instance=instance, role=role, path=str(path), request_id=doc.get("request_id"),
        harness=harness, provider=doc.get("provider"), model=doc.get("model"),
        profile=doc.get("profile"), outcome=str(doc.get("outcome") or "unknown"),
        started_at=started, ended_at=float(ended), duration_ms=duration,
        num_turns=doc.get("num_turns") if isinstance(doc.get("num_turns"), int) else None,
        tokens=tokens, cost_usd=cost, cost_kind=kind,
        channel=channel, topic=topic, generation=generation,
        attribution="fields" if channel and topic else "none",
    )


# --- attributing old records to a conversation -------------------------------


@dataclass
class _Workspace:
    channel: str
    topic: str
    generation: int
    role: str
    start: float
    end: float


def _workspaces(root: Path) -> list[_Workspace]:
    """Every generation directory of an instance, with the span of its mtimes."""
    topics = root / ".local" / "topics"
    found: list[_Workspace] = []
    if not topics.is_dir():
        return found
    for channel in topics.iterdir():
        if not channel.is_dir():
            continue
        for topic in channel.iterdir():
            if not topic.is_dir():
                continue
            for generation in topic.iterdir():
                if not generation.is_dir() or not generation.name.isdigit():
                    continue
                for role in generation.iterdir():
                    if not role.is_dir():
                        continue
                    stamps = [role.stat().st_mtime, generation.stat().st_mtime]
                    for child in role.iterdir():
                        try:
                            stamps.append(child.stat().st_mtime)
                        except OSError:
                            continue
                    found.append(_Workspace(
                        channel.name, topic.name, int(generation.name), role.name,
                        min(stamps), max(stamps),
                    ))
    return found


def _attribute_by_window(rows: list[Row], spaces: list[_Workspace]) -> None:
    """Give a record without `channel`/`topic` the workspace its span overlaps.

    `/inflight`'s observation the other way round: the generation directory
    is built just before the run starts, and whatever else lands in it lands
    during or just after the run. So a record whose own span (start derived
    from `duration_ms`, end from the file's mtime) overlaps the directory's
    mtime span, plus slack, belongs to it; the nearest start wins. Each
    workspace is spent once, newest record first, so a role that serves two
    generations back to back does not hand both to one directory.
    """
    if not spaces:
        return
    spaces = sorted(spaces, key=lambda s: s.start)
    spent: set[int] = set()
    for row in sorted(rows, key=lambda r: r.ended_at, reverse=True):
        if row.attribution == "fields":
            continue
        started = row.started_at if row.started_at is not None else row.ended_at
        best: tuple[float, int] | None = None
        for index, space in enumerate(spaces):
            if index in spent:
                continue
            if started <= space.end + WINDOW_SLACK_SECONDS and row.ended_at >= space.start - WINDOW_SLACK_SECONDS:
                distance = abs(started - space.start)
                if best is None or distance < best[0]:
                    best = (distance, index)
        if best is None:
            continue
        spent.add(best[1])
        space = spaces[best[1]]
        row.channel, row.topic, row.generation = space.channel, space.topic, space.generation
        row.attribution = "window"


# --- the aggregate -------------------------------------------------------------


def _bucket() -> dict:
    return {
        "runs": 0, "failed": 0, "usd_reported": 0.0, "usd_estimated": 0.0,
        "tokens_in": 0, "tokens_out": 0,
        "kinds": {kind: 0 for kind in KINDS},
    }


def _add(bucket: dict, row: Row) -> None:
    bucket["runs"] += 1
    if row.outcome != "done":
        bucket["failed"] += 1
    bucket["kinds"][row.cost_kind] = bucket["kinds"].get(row.cost_kind, 0) + 1
    if row.cost_usd is not None:
        key = "usd_reported" if row.cost_kind == "reported" else "usd_estimated"
        bucket[key] = round(bucket[key] + row.cost_usd, 6)
    if row.tokens:
        bucket["tokens_in"] += row.tokens["input"] + row.tokens["cached_input"] + row.tokens["cache_write"]
        bucket["tokens_out"] += row.tokens["output"]


def _by_harness(rows: list[Row]) -> dict:
    out: dict[str, dict] = {}
    for row in rows:
        _add(out.setdefault(row.harness or "unknown", _bucket()), row)
    return out


def _total(rows: list[Row]) -> dict:
    bucket = _bucket()
    for row in rows:
        _add(bucket, row)
    bucket["by_harness"] = _by_harness(rows)
    return bucket


def _day(stamp: float) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(stamp))


def _day_start(stamp: float) -> float:
    local = time.localtime(stamp)
    return time.mktime((local.tm_year, local.tm_mon, local.tm_mday, 0, 0, 0, 0, 0, -1))


class Cost:
    """Scan the roots, keep the rows, answer the board."""

    def __init__(self, roots: dict[str, Path], prices_path: Path | None = None) -> None:
        self.roots = dict(roots)
        self.prices_path = prices_path
        self._lock = threading.Lock()
        self._rows: dict[str, Row] = {}
        self._seen: dict[str, float] = {}
        self._prices: Prices | None = None
        self._prices_stamp: float | None = None

    # -- reading ------------------------------------------------------------

    def prices(self) -> Prices:
        """The table, re-read when the file changes (a price is a thing one edits)."""
        stamp = None
        if self.prices_path is not None:
            try:
                stamp = self.prices_path.stat().st_mtime
            except OSError:
                stamp = None
        if self._prices is None or stamp != self._prices_stamp:
            self._prices = read_prices(self.prices_path)
            self._prices_stamp = stamp
            self._rows.clear()
            self._seen.clear()
        return self._prices

    def scan(self) -> dict:
        """Re-read what changed. ~1000 files is a few milliseconds of stat."""
        with self._lock:
            prices = self.prices()
            roots_report = []
            present: set[str] = set()
            for instance, root in self.roots.items():
                agent = root / ".local" / "agent"
                report = {"instance": instance, "ok": agent.is_dir(), "records": 0}
                if agent.is_dir():
                    for role in agent.iterdir():
                        if not role.is_dir():
                            continue
                        for path in role.glob("run-*.json"):
                            key = str(path)
                            present.add(key)
                            try:
                                mtime = path.stat().st_mtime
                            except OSError:
                                continue
                            if self._seen.get(key) == mtime:
                                report["records"] += 1
                                continue
                            try:
                                doc = json.loads(path.read_text(encoding="utf-8"))
                            except (OSError, ValueError):
                                continue
                            if not isinstance(doc, dict):
                                continue
                            self._rows[key] = _row(instance, role.name, path, doc, prices)
                            self._seen[key] = mtime
                            report["records"] += 1
                roots_report.append(report)
            for key in list(self._rows):
                if key not in present:
                    del self._rows[key]
                    self._seen.pop(key, None)
            rows = list(self._rows.values())
            # Attribution is recomputed on every scan: cheap, and a workspace
            # that gained a file since last time may now hold a record.
            for instance, root in self.roots.items():
                mine = [row for row in rows if row.instance == instance]
                for row in mine:
                    if row.attribution == "window":
                        row.channel = row.topic = row.generation = None
                        row.attribution = "none"
                _attribute_by_window(mine, _workspaces(root))
            return {"roots": roots_report, "rows": rows, "prices": prices}

    # -- the board ----------------------------------------------------------

    def board(self, now: float | None = None, *, roster: list[str] = (),
              routine_sessions: dict[str, list[dict]] | None = None) -> dict:
        """Everything the gauge page draws, in one read.

        `roster` is the ops engine's list of instances, so an instance this
        host has no root for is named as missing. `routine_sessions` maps a
        routine name to its sessions as `/routines/<name>` returns them; each
        session's conversations are matched against the rows' `channel`/`topic`.
        """
        now = time.time() if now is None else now
        scanned = self.scan()
        rows: list[Row] = scanned["rows"]
        today = _day_start(now)
        week = now - 7 * 86400
        month = now - 30 * 86400
        by_topic: dict[tuple[str, str], list[Row]] = defaultdict(list)
        for row in rows:
            if row.channel and row.topic:
                by_topic[(row.channel, row.topic)].append(row)

        days = []
        for back in range(DAYS - 1, -1, -1):
            start = today - back * 86400
            slice_ = [row for row in rows if start <= row.ended_at < start + 86400]
            days.append({"day": _day(start), "start": start, **_total(slice_)})

        table_map: dict[tuple, list[Row]] = defaultdict(list)
        for row in rows:
            table_map[(row.instance, row.role, row.harness or "unknown", row.model or "")].append(row)
        table = []
        for (instance, role, harness, model), group in sorted(table_map.items()):
            kinds = {row.cost_kind for row in group}
            table.append({
                "instance": instance, "role": role, "harness": harness, "model": model,
                "cost_kind": next(iter(kinds)) if len(kinds) == 1 else "mixed",
                "last_at": max(row.ended_at for row in group),
                **{k: v for k, v in _total(group).items() if k != "by_harness"},
            })

        routines = []
        for name, sessions in (routine_sessions or {}).items():
            listed = []
            for session in sessions:
                # A session names its own channel (`routines.session_of`);
                # before `refine_routine` p1 every run lived in `#front`.
                topics = ([(session.get("channel") or "front", session.get("topic"))]
                          if session.get("topic") else [])
                for node in session.get("nodes") or []:
                    if node.get("channel") and node.get("topic"):
                        topics.append((node["channel"], node["topic"]))
                matched: list[Row] = []
                for key in topics:
                    matched.extend(by_topic.get(key, []))
                by_instance: dict[tuple[str, str, str], list[Row]] = defaultdict(list)
                for row in matched:
                    by_instance[(row.instance, row.role, row.harness or "unknown")].append(row)
                opened = session.get("opened") or {}
                listed.append({
                    "channel": session.get("channel") or "front", "topic": session.get("topic"),
                    "opened_at": opened.get("at"), "resolution": (session.get("resolution") or {}).get("state"),
                    "conversations": [{"channel": c, "topic": t, "runs": len(by_topic.get((c, t), []))}
                                      for c, t in topics],
                    "attribution": {
                        "fields": sum(1 for row in matched if row.attribution == "fields"),
                        "window": sum(1 for row in matched if row.attribution == "window"),
                    },
                    "agents": [
                        {"instance": i, "role": r, "harness": h,
                         **{k: v for k, v in _total(group).items() if k != "by_harness"}}
                        for (i, r, h), group in sorted(by_instance.items())
                    ],
                    **{k: v for k, v in _total(matched).items() if k != "by_harness"},
                })
            routines.append({"name": name, "sessions": listed})

        unattributed = [row for row in rows if not (row.channel and row.topic)]
        recent = sorted(rows, key=lambda row: row.ended_at, reverse=True)[:RECENT]
        return {
            "schema": COST_SCHEMA,
            "generated_at": now,
            "roots": scanned["roots"],
            "missing": sorted(set(roster) - set(self.roots)),
            "prices": scanned["prices"].payload(),
            "totals": {
                "today": _total([row for row in rows if row.ended_at >= today]),
                "days7": _total([row for row in rows if row.ended_at >= week]),
                "days30": _total([row for row in rows if row.ended_at >= month]),
                "all": _total(rows),
            },
            "days": days,
            "table": table,
            "routines": routines,
            "unattributed": {k: v for k, v in _total(unattributed).items() if k != "by_harness"},
            "recent": [row.payload() for row in recent],
            "settings": {"days": DAYS, "window_slack_seconds": WINDOW_SLACK_SECONDS},
        }


def prices_path_from_env() -> Path | None:
    value = os.environ.get(PRICES_VARIABLE, "")
    if value:
        return Path(value).expanduser()
    return DEFAULT_PRICES if DEFAULT_PRICES.is_file() else None
