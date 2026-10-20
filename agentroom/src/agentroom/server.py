"""The relay's HTTP door: stdlib, unauthenticated, on the LAN.

Modelled on cagent's *window* listener
(`pj-clusterintent/cagent/src/cagent_api/server.py`): `ThreadingHTTPServer`,
no framework, no auth, in a private lab.

Since workflow_editor p15 it serves only what the workflow editor's Usage
view (and Front, by `curl`) read from this host: the harness logins' windows
(`/budget`) and, as history, the pre-WFE agents' records (`/cost`). The
Front Desk's panels, the Arguing Room and the Zulip mirror behind them are
retired; earlier routes are in the episodes (`agent_room`, `operation_room`,
`front_desk`, `argue`, `progress_panel`, `retire_old_ui`, `workflow_editor`
p15).

CORS is answered permissively: there is nothing here to protect from a page
that can already reach the port.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from .budget import Budget
from .cost import ROOTS_VARIABLE, Cost

ROUTES = ("/healthz", "/budget", "/cost")


def make_handler(cost: Cost | None = None, budget: Budget | None = None):
    class Handler(BaseHTTPRequestHandler):
        server_version = "agentroom/0.2.0"

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
                elif path == "/cost":
                    # Host files only, so it may be polled: the pre-WFE
                    # agents' records, read as history by the workflow
                    # editor's Usage view.
                    if cost is None:
                        self._write_json(503, {
                            "error": "the cost read is not configured; "
                                     f"set {ROOTS_VARIABLE} to the instance roots on this host",
                        })
                    else:
                        self._write_json(200, cost.board())
                elif path == "/budget":
                    # Calls the vendors (through the CLIs' own reads); the
                    # per-provider cache in budget.py limits those calls,
                    # not the caller.
                    if budget is None:
                        self._write_json(503, {"error": "the budget read is not configured"})
                    else:
                        self._write_json(200, budget.snapshot())
                else:
                    self._write_json(404, {"error": f"no route {path}", "routes": list(ROUTES)})
            except Exception as error:  # noqa: BLE001 — a read failure is an answer
                self._write_json(502, {"error": f"{type(error).__name__}: {error}"})

    return Handler


def build_server(host: str, port: int, cost: Cost | None = None, budget: Budget | None = None) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), make_handler(cost, budget))
