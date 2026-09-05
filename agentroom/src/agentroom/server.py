"""The agent room's HTTP door: stdlib, read-only, unauthenticated.

Modelled on cagent's *window* listener
(`pj-clusterintent/cagent/src/cagent_api/server.py`): `ThreadingHTTPServer`,
no framework, no auth. cagent needs three doors because two of them can change
the cluster; this one only reads a chat realm the browser's own user can read
anyway, on a loopback port in a private lab, so the window's shape is the whole
of what it needs. If it ever grows a write route it needs cagent's other doors
too, not a flag.

CORS is answered permissively for the same reason: the frontend may be served
from vite (:5173) or nginx (:8090), and there is nothing here to protect from
a page that can already reach the port.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from .ops import Ops
from .room import Room

ROUTES = ("/healthz", "/agents", "/work", "/ops")


def make_handler(room: Room, ops: Ops | None = None):
    class Handler(BaseHTTPRequestHandler):
        server_version = "agentroom/0.1.0"

        def log_message(self, fmt: str, *args) -> None:  # quieter default logging
            pass

        def _write_json(self, status: int, payload) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:  # noqa: N802 (stdlib naming)
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            path = urlparse(self.path).path.rstrip("/") or "/"
            try:
                if path == "/healthz":
                    self._write_json(200, {"ok": True})
                elif path == "/":
                    self._write_json(200, {"service": "agentroom", "routes": list(ROUTES)})
                elif path == "/agents":
                    self._write_json(200, room.agents())
                elif path == "/work":
                    self._write_json(200, room.work())
                elif path == "/ops":
                    # Without a credential of its own the engine does not run,
                    # and the view must be told that rather than shown an
                    # empty board — an unreadable room and a quiet one look
                    # identical, which is the failure this whole view exists
                    # to prevent.
                    if ops is None:
                        self._write_json(503, {
                            "error": "the ops engine is not configured; "
                                     "set OPSROOM_ZULIP_ENV to its own bot credential",
                        })
                    else:
                        self._write_json(200, ops.snapshot())
                else:
                    self._write_json(404, {"error": f"no route {path}", "routes": list(ROUTES)})
            except Exception as error:
                # A Zulip outage is the expected failure here, and the view
                # says so rather than rendering an empty room.
                self._write_json(502, {"error": f"{type(error).__name__}: {error}"})

    return Handler


def build_server(host: str, port: int, room: Room, ops: Ops | None = None) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), make_handler(room, ops))
