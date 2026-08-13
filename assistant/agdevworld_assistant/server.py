"""The agdevworld assistant service, in Python.

Stdlib HTTP plus `agag` (pyagag) for everything about agent identity and
process launch. This module is taking over `server.mjs` route by route; during
the port nginx sends the ported paths here and the rest to the JavaScript
service, so both answer at the same time from the same `/records` volume.

Routes so far:

  GET  /healthz              liveness probe
  GET  /api/guide, /guide    GUIDE.md as text/plain
  POST /api/chat             one bounded front run -> {reply, actions, run}
  POST /api/note             {"text": "..."} -> an assistant.note.v1 record
  *    /api/forge/...        passthrough to the agforge request service
  *    /api/autolab/...      node reachability + passthrough to node gateways
  *    /api/plane/...        project-scoped Plane passthrough

Stateless: the browser owns the conversation history and sends it whole.
"""

import json
import os
import signal
import sys
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .chat import ChatFailure, ChatAnswer, VALIDATION_DETAIL, compose_prompt, compose_system, run_front, valid_messages
from .overlay import write_overlay
from .passthrough import handle_autolab, handle_forge, handle_plane
from .workflows import handle_freeforge, handle_missions
from .records import RUN_SCHEMA, NOTE_SCHEMA, record_note, record_run
from .settings import RECORDS_DIR, read_guide

BAD_JSON = "Body must be JSON."


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def handle_chat(payload) -> tuple[int, dict]:
    """Resolve, run and record one chat. Returns the status and the body."""
    messages = payload.get("messages") if isinstance(payload, dict) else None
    if not valid_messages(messages):
        return 400, {"error": "bad_request", "detail": VALIDATION_DETAIL}

    system = compose_system(payload.get("context"), read_guide())
    run_id = str(uuid.uuid4())
    record = {"schema": RUN_SCHEMA, "id": run_id, "started": _now(), "outcome": "failed"}
    try:
        answer = run_front(
            compose_prompt(system, messages),
            transcript_path=RECORDS_DIR / f"{run_id}.agent.jsonl",
        )
    except ChatFailure as failure:
        record.update(failure.meta)
        record["failure"] = str(failure)
        record["outcome"] = failure.outcome
        record_run(record)
        return 502, {"error": "assistant_offline", "detail": str(failure)}
    return 200, _answered(record, answer)


def _answered(record: dict, answer: ChatAnswer) -> dict:
    record.update(answer.meta)
    record["actions"] = [action.get("action") for action in answer.actions]
    record["outcome"] = "done"
    record_run(record)
    return {
        "reply": answer.reply,
        "actions": answer.actions,
        "run": {
            "id": record["id"],
            "role": record.get("role"),
            "profile": record.get("profile"),
            "harness": record.get("harness"),
            "provider": record.get("provider"),
            "model": record.get("model"),
            "outcome": record["outcome"],
        },
    }


def handle_note(payload) -> tuple[int, dict]:
    """The one thing the assistant can leave behind: free text in the records."""
    text = payload.get("text") if isinstance(payload, dict) else None
    if not isinstance(text, str) or not text.strip():
        return 400, {"error": "bad_request", "detail": 'Body must be {"text": "..."}.'}
    record = {"schema": NOTE_SCHEMA, "id": str(uuid.uuid4()), "written": _now(), "text": text}
    record_note(record)
    return 201, {"kind": NOTE_SCHEMA, "id": record["id"], "written": record["written"]}


class Handler(BaseHTTPRequestHandler):
    server_version = "agdevworld-assistant/2"
    # The frontend and nginx both keep connections alive; 1.0 would close each
    # response and make every chat request pay a fresh handshake.
    protocol_version = "HTTP/1.1"

    def send_json(self, code, obj):
        self.send_bytes(code, "application/json; charset=utf-8", json.dumps(obj).encode())

    def send_text(self, code, text):
        self.send_bytes(code, "text/plain; charset=utf-8", text.encode())

    def send_bytes(self, code, content_type, body):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length)

    def read_json(self):
        return json.loads(self.read_body() or b"null")

    # The passthrough prefixes, checked after the workflow routes: the exact
    # workflow paths under /api/autolab/ are Zulip/provisioning calls, never
    # proxied to a node.
    PASSTHROUGHS = (
        ("/api/forge/", handle_forge),
        ("/api/autolab/", handle_autolab),
        ("/api/plane/", handle_plane),
    )

    # POST-only JSON routes served by this process itself (the workflow trio
    # grows /api/autolab/projects in step 3).
    MISSION_PATHS = ("/api/autolab/missions", "/api/autolab/missions/resolve")

    def workflow_handler(self, path):
        if path.startswith("/api/freeforge/"):
            return lambda payload: handle_freeforge(path, payload)
        if path in self.MISSION_PATHS:
            return lambda payload: handle_missions(path, payload)
        return None

    def passthrough(self, method):
        """Serve the path if a passthrough owns it. Returns whether it did."""
        for prefix, handler in self.PASSTHROUGHS:
            if not self.path.startswith(prefix):
                continue
            try:
                reply = handler(
                    method, self.path, self.headers.get("Content-Type"),
                    self.read_body() if method != "GET" else None,
                )
            except Exception as error:  # an unhandled failure is still an answer
                print(f"unhandled {prefix} passthrough error: {error!r}", file=sys.stderr, flush=True)
                self.send_json(500, {"error": "internal_error", "detail": "Unexpected passthrough failure."})
                return True
            self.send_bytes(reply.status, reply.content_type, reply.body)
            return True
        return False

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/healthz":
            return self.send_json(200, {"ok": True})
        if path in ("/api/guide", "/guide"):
            return self.send_text(200, read_guide())
        if self.workflow_handler(path):
            return self.send_json(405, {"error": "method_not_allowed"})
        if self.passthrough("GET"):
            return
        self.send_json(404, {"error": "not_found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        handler = ({"/api/chat": handle_chat, "/api/note": handle_note}.get(path)
                   or self.workflow_handler(path))
        if handler is None:
            if self.passthrough("POST"):
                return
            return self.send_json(404, {"error": "not_found"})
        try:
            payload = self.read_json()
        except (ValueError, OSError):
            return self.send_json(400, {"error": "bad_request", "detail": BAD_JSON})
        try:
            code, body = handler(payload)
        except Exception as error:  # an unhandled failure is still an answer
            print(f"unhandled {path} error: {error!r}", file=sys.stderr, flush=True)
            return self.send_json(
                500, {"error": "internal_error", "detail": "Unexpected assistant failure."}
            )
        self.send_json(code, body)

    def do_PATCH(self):
        if self.workflow_handler(self.path.split("?")[0]):
            return self.send_json(405, {"error": "method_not_allowed"})
        if not self.passthrough("PATCH"):
            self.send_json(404, {"error": "not_found"})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8093"))
    write_overlay()
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"assistant (python) listening on {host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
