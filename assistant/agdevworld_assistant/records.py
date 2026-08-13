"""Run and note records (devpolicy/agent_records.md).

Every record goes to two places: one JSON line on stdout, which is what
`docker compose logs` shows, and a durable file in the records volume, because
the container log does not survive `up --build`.

The file shape converges on agautolab's — `{"schema": "ag.agent-run.v1", **meta}`
— rather than on `agag.harness.write_run_record`, whose key whitelist drops
`actions`. Both services write into the same volume during the port; nothing
here reads or rewrites a record the JavaScript side left behind.
"""

import json
import sys

from .settings import RECORDS_DIR

RUN_SCHEMA = "ag.agent-run.v1"
NOTE_SCHEMA = "assistant.note.v1"


def write_record(kind: str, record: dict, filename: str) -> None:
    print(json.dumps({"kind": kind, **record}, ensure_ascii=False), flush=True)
    try:
        RECORDS_DIR.mkdir(parents=True, exist_ok=True)
        (RECORDS_DIR / filename).write_text(
            json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    except OSError as error:
        print(f"could not write the record to disk: {error}", file=sys.stderr, flush=True)


def record_run(record: dict) -> None:
    write_record("assistant.run.v1", record, f"{record['id']}.json")


def record_note(record: dict) -> None:
    write_record(NOTE_SCHEMA, record, f"{record['id']}.note.json")
