"""forge's work record, as this room reads it.

The companion of `autolab.py`, and it exists for the same reason: since
`refactor` p2 an asset request is kept in the Zulip conversations it happens
in, not in a Plane issue, so there is nothing to bridge to any more. This
module reproduces the format `agforge.anchor` writes — this room is a
*reader* of other agents' realms and holds no dependency on any of their
packages — one line per fact:

    [selfnote][asset] <stem>            in an assetplan- topic  → the request
    [selfnote][doc] <message id>        which post is the current plan
    [selfnote][tools] <names>           the toolsets it was planned with
    [selfnote][assetrun] <request id>   in an assetrun- topic   → the run
    [selfnote][state] <word>            where the conversation has got to
    [selfnote][result] <object key>     one durable asset it produced
    [selfnote][replaces] <message id>   the request this one replaced

The two rules are the writer's, and they are autolab's: **identity is
written once**, so the earliest note of its kind wins and its own message id
*is* the record; **state and the current plan change**, so the newest note
wins.

## forge's lifecycle is not autolab's

autolab's rule is parent/child counting: a mission is finished when every
one of its tasks is. forge has no such shape. A request is planned, and then
one run either delivers an asset or does not; running it again is a fresh
attempt at the same request, not another child that must also finish. So the
question this room asks of a forge request is **has anything been
delivered** — and the three things stay distinct exactly as they do for
autolab:

| what happened | who says it | how it is written |
|---|---|---|
| the generation succeeded | the run, in its own topic | `[state] delivered` on the run |
| the asset reached the requester | the run, in the request's topic | `[state] delivered` on the request |
| a person accepted it | this room's button | `[state] accepted` |
| the conversation is over | the same button, afterwards | Zulip's `✔ ` |

A request whose newest state is `pending` has a ComfyUI job still running.
It is **blocked**, which is what keeps its conversation and its run topic
reachable (`close._hold_dependents`) until the generation lands.

A `retired` request is another request — the one that replaced it is the one
to finish — and is never closed alongside its replacement, the same boundary
`MISSION_REPLACED` draws for autolab.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

from agag.selfnote import parse_note

#: forge's own tags, beside the shared `rootchat` and `served`.
ASSET_TAG = "asset"
RUN_TAG = "assetrun"
DOC_TAG = "doc"
TOOLS_TAG = "tools"
STATE_TAG = "state"
RESULT_TAG = "result"
REPLACES_TAG = "replaces"
TAGS = (ASSET_TAG, RUN_TAG, DOC_TAG, TOOLS_TAG, STATE_TAG, RESULT_TAG, REPLACES_TAG)

#: A request's states, as the writer words them.
REQUEST_PLANNED = "planned"
REQUEST_DELIVERED = "delivered"
REQUEST_FAILED = "failed"
REQUEST_RETIRED = "retired"
#: What this room writes when a person accepts the asset. forge never writes
#: it, which is the point: acceptance is somebody else's word.
REQUEST_ACCEPTED = "accepted"

#: A run's states.
RUN_PENDING = "pending"
RUN_DELIVERED = "delivered"
RUN_FAILED = "failed"

#: The one state word somebody other than the record's author may write —
#: `autolab.EXTERNAL_STATES`' rule, for `refactor` p1 step 4's reason: the
#: room writes acceptance with the *human's* credential, and a reader that
#: took states only from the record's own author would not see its own write.
EXTERNAL_STATES = (REQUEST_ACCEPTED,)

#: Said when a request has already been accepted, so a caller can recognise
#: the no-op.
ALREADY_ACCEPTED = "it is already accepted"

__all__ = [
    "ALREADY_ACCEPTED", "STATE_TAG", "EXTERNAL_STATES", "Note", "REQUEST_ACCEPTED", "REQUEST_DELIVERED",
    "REQUEST_FAILED", "REQUEST_PLANNED", "REQUEST_RETIRED", "RUN_DELIVERED", "RUN_FAILED",
    "RUN_PENDING", "Request", "Run", "TAGS", "notes_in", "read_record", "reason_not_accepted",
    "request_label", "run_label",
]


@dataclass(frozen=True)
class Note:
    """One of forge's selfnotes, with who wrote it and where."""

    tag: str
    value: str
    message_id: int
    by_id: int
    by: str

    def as_tuple(self) -> tuple[str, str, int, int, str]:
        return (self.tag, self.value, self.message_id, self.by_id, self.by)

    @classmethod
    def of(cls, entry) -> "Note":
        tag, value, message_id, by_id, by = entry
        return cls(str(tag), str(value), int(message_id), int(by_id), str(by))


def notes_in(messages: Iterable[dict]) -> list[Note]:
    """Every forge note in one topic's history, oldest first.

    Every note, from every sender: picking is the caller's job, the same
    discipline `autolab.notes_in` follows.
    """
    found: list[Note] = []
    for message in messages:
        content = message.get("content")
        for tag in TAGS:
            value = parse_note(content, tag)
            if value is None:
                continue
            found.append(Note(
                tag=tag, value=value.strip(),
                message_id=int(message.get("id") or 0),
                by_id=int(message.get("sender_id") or 0),
                by=str(message.get("sender_full_name") or ""),
            ))
            break
    found.sort(key=lambda note: note.message_id)
    return found


def request_label(anchor_id: int) -> str:
    """`a5912` — a request's anchor id, worn as a name."""
    return f"a{int(anchor_id)}"


def run_label(anchor_id: int) -> str:
    """`r5913` — a run's anchor id, worn as a name."""
    return f"r{int(anchor_id)}"


def _earliest(notes: list[Note], tag: str) -> Note | None:
    return next((note for note in notes if note.tag == tag), None)


def _newest_value(notes: list[Note], tag: str) -> str | None:
    found = [note for note in notes if note.tag == tag]
    return found[-1].value if found else None


def _int(value: str | None) -> int | None:
    try:
        return int((value or "").strip())
    except (TypeError, ValueError):
        return None


@dataclass
class Request:
    """One asset request: the conversation that plans it, and its state."""

    anchor_id: int
    stem: str
    channel: str
    topic: str
    state: str = REQUEST_PLANNED
    #: The message id of the visible post holding the current plan, if any.
    document_id: int | None = None
    #: The toolsets it was planned with; `None` when nobody recorded any.
    tools: list[str] | None = None
    #: The anchor id of the request this one replaced, if any.
    replaces: int | None = None
    by: str = ""
    #: Durable object keys this request has delivered, oldest first.
    results: list[str] = field(default_factory=list)
    runs: list["Run"] = field(default_factory=list)

    @property
    def label(self) -> str:
        return request_label(self.anchor_id)

    def as_dict(self) -> dict:
        return {"anchor_id": self.anchor_id, "stem": self.stem, "channel": self.channel,
                "topic": self.topic, "state": self.state, "document_id": self.document_id,
                "tools": self.tools, "replaces": self.replaces, "by": self.by,
                "results": self.results, "label": self.label}


@dataclass
class Run:
    """One execution conversation, and the request it executes."""

    anchor_id: int
    request_id: int
    channel: str
    topic: str
    state: str = ""
    results: list[str] = field(default_factory=list)
    by: str = ""

    @property
    def label(self) -> str:
        return run_label(self.anchor_id)

    @property
    def pending(self) -> bool:
        return self.state == RUN_PENDING

    def as_dict(self) -> dict:
        return {"anchor_id": self.anchor_id, "request_id": self.request_id,
                "channel": self.channel, "topic": self.topic, "state": self.state,
                "results": self.results, "label": self.label}


def read_record(channel: str, topic: str, notes: list[Note]) -> Request | Run | None:
    """The request or run this conversation *is*, or None for neither.

    A topic carries one or the other, never both. **The identity note's
    author is the record's author**, and only that sender's other notes are
    read — a visitor's `[state]` line must not be able to say where somebody
    else's work has got to. The exception is `EXTERNAL_STATES`, which is the
    reason this room can write acceptance at all.
    """
    identity = _earliest(notes, ASSET_TAG) or _earliest(notes, RUN_TAG)
    if identity is None:
        return None
    own = [note for note in notes if note.by_id == identity.by_id]
    state = _newest_value(
        [note for note in notes
         if note.by_id == identity.by_id or note.value.strip().lower() in EXTERNAL_STATES],
        STATE_TAG,
    )
    results = []
    for note in own:
        if note.tag == RESULT_TAG and note.value and note.value not in results:
            results.append(note.value)
    asset = _earliest(own, ASSET_TAG)
    if asset is not None:
        raw = _newest_value(own, TOOLS_TAG)
        return Request(
            anchor_id=asset.message_id, stem=asset.value, channel=channel, topic=topic,
            state=(state or REQUEST_PLANNED).lower(),
            document_id=_int(_newest_value(own, DOC_TAG)),
            tools=_tools(raw), replaces=_int(_newest_value(own, REPLACES_TAG)),
            by=asset.by, results=results,
        )
    run = _earliest(own, RUN_TAG)
    request_id = _int(run.value) if run is not None else None
    if run is None or request_id is None:
        return None
    return Run(anchor_id=run.message_id, request_id=request_id, channel=channel,
               topic=topic, state=(state or "").lower(), results=results, by=run.by)


def _tools(value: str | None) -> list[str] | None:
    """The recorded toolset selection. `None` and `[]` are different answers:
    `agforge.anchor.NO_TOOLS` (`-`) is a selection of none, and no note at
    all is nobody having recorded one."""
    if value is None:
        return None
    if value.strip() == "-":
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


def reason_not_accepted(request: Request, runs: list[Run]) -> str | None:
    """Why this request may not be accepted, or None when it may.

    forge's lifecycle, not autolab's counting rule: what makes a request
    finished is that **something was delivered**, not that every run of it
    completed. A second attempt after a failure is the same request trying
    again, and the newest state is its verdict.
    """
    if request.state == REQUEST_ACCEPTED:
        return ALREADY_ACCEPTED
    if request.state == REQUEST_RETIRED:
        return "it was retired, and its replacement is the request to finish"
    if any(run.pending for run in runs):
        waiting = ", ".join(run.label for run in runs if run.pending)
        return f"a generation is still running ({waiting}), so nothing has been delivered yet"
    if request.state == REQUEST_FAILED:
        return "its last attempt failed; run it again or retire it"
    if request.state != REQUEST_DELIVERED:
        return "nothing has been delivered yet"
    return None
