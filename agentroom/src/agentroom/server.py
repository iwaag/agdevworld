"""The agent room's HTTP door: stdlib, unauthenticated, loopback.

Modelled on cagent's *window* listener
(`pj-clusterintent/cagent/src/cagent_api/server.py`): `ThreadingHTTPServer`,
no framework, no auth. cagent needs three doors because two of them can change
the cluster; this one reads a chat realm the browser's own user can read
anyway, on a loopback port in a private lab, so the window's shape is the whole
of what it needs.

There is now exactly one POST, and it is worth being precise about why it did
not buy cagent's other doors. `POST /ops/confirm` writes to **this process's
own memory**: it marks which `done` rows a human has looked at. It reaches
neither Zulip nor any node — the observer still never posts (`operation_room`
p2 constraint 5) — and its effect dies with the relay, along with the rows it
hides. A route that could change the realm would be a different thing and
would need a different door.

CORS is answered permissively for the same reason: the frontend may be served
from vite (:5173) or nginx (:8090), and there is nothing here to protect from
a page that can already reach the port.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

from .ops import Ops
from .room import Room

ROUTES = ("/healthz", "/agents", "/work", "/ops", "/routines", "/routines/<name>")
WRITE_ROUTES = ("/ops/confirm",)


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
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            path = urlparse(self.path).path.rstrip("/") or "/"
            try:
                if path == "/healthz":
                    self._write_json(200, {"ok": True})
                elif path == "/":
                    self._write_json(200, {
                        "service": "agentroom",
                        "routes": list(ROUTES),
                        "post": list(WRITE_ROUTES),
                    })
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
                elif path == "/routines":
                    # The routine board is the same engine's reading of the
                    # same realm, so it degrades the same way: no credential,
                    # no board, and it says which variable is missing.
                    if ops is None:
                        self._write_json(503, {
                            "error": "the ops engine is not configured; "
                                     "set OPSROOM_ZULIP_ENV to its own bot credential",
                        })
                    else:
                        self._write_json(200, ops.routines())
                elif path.startswith("/routines/"):
                    if ops is None:
                        self._write_json(503, {
                            "error": "the ops engine is not configured; "
                                     "set OPSROOM_ZULIP_ENV to its own bot credential",
                        })
                    else:
                        # The name is a topic suffix, so it arrives percent
                        # encoded and is never used to build a path or a
                        # narrow — it is matched against the routines the
                        # engine already found.
                        found = ops.routine(unquote(path[len("/routines/"):]))
                        self._write_json(404 if found.get("error") else 200, found)
                else:
                    self._write_json(404, {"error": f"no route {path}", "routes": list(ROUTES)})
            except Exception as error:
                # A Zulip outage is the expected failure here, and the view
                # says so rather than rendering an empty room.
                self._write_json(502, {"error": f"{type(error).__name__}: {error}"})

        def do_POST(self) -> None:  # noqa: N802
            path = urlparse(self.path).path.rstrip("/") or "/"
            if path != "/ops/confirm":
                self._write_json(404, {"error": f"no POST route {path}",
                                       "post": list(WRITE_ROUTES)})
                return
            if ops is None:
                self._write_json(503, {
                    "error": "the ops engine is not configured; "
                             "set OPSROOM_ZULIP_ENV to its own bot credential",
                })
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length > 0 else b""
                # No body at all is the common case — the view's one button
                # means "all of them" — so an empty request is not an error.
                body = json.loads(raw) if raw.strip() else {}
            except (ValueError, json.JSONDecodeError) as error:
                self._write_json(400, {"error": f"unreadable body: {error}"})
                return
            if not isinstance(body, dict):
                self._write_json(400, {"error": "body must be a JSON object"})
                return

            channel, topic = body.get("channel"), body.get("topic")
            if channel is None and topic is None:
                if body.get("all", True) is not True:
                    self._write_json(400, {
                        "error": "pass {\"all\": true} or a {channel, topic} pair",
                    })
                    return
                target = None
            elif channel is None or topic is None:
                self._write_json(400, {"error": "channel and topic go together"})
                return
            else:
                target = (str(channel), str(topic))

            try:
                found = ops.confirm(target)
            except Exception as error:
                self._write_json(502, {"error": f"{type(error).__name__}: {error}"})
                return
            # 409, not 400: the request was well formed and the *state* is what
            # refused it. Only `done` may be dismissed — the relay decides
            # that, so a view that forgets to hide the button cannot clear a
            # stall off the screen.
            self._write_json(409 if found.get("refused") else
                             404 if found.get("error") else 200, found)

    return Handler


def build_server(host: str, port: int, room: Room, ops: Ops | None = None) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), make_handler(room, ops))
