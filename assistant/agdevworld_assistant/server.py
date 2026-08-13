"""The agdevworld assistant service, in Python.

Stdlib HTTP plus `agag` (pyagag) for everything about agent identity and
process launch. This module is taking over `server.mjs` route by route; during
the port nginx sends the ported paths here and the rest to the JavaScript
service, so both answer at the same time from the same `/records` volume.

Routes so far:

  GET /healthz              liveness probe
  GET /api/guide, /guide    GUIDE.md as text/plain

The entrance guide is read from disk on **every** request. That is the cagent
llms.txt pattern and it is deliberate: editing the card changes the next
answer without a restart, and with the file bind-mounted, without a rebuild
either. An unreadable card is not a 500 — the assistant simply has no card.
"""

import json
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ASSISTANT_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = ASSISTANT_DIR.parent
GUIDE_PATH = ASSISTANT_DIR / "GUIDE.md"

NO_GUIDE = "No capability card is installed on this assistant."


def read_guide() -> str:
    try:
        return GUIDE_PATH.read_text(encoding="utf-8")
    except OSError as error:
        print(f"capability card unreadable: {error}", file=sys.stderr, flush=True)
        return NO_GUIDE


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

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/healthz":
            return self.send_json(200, {"ok": True})
        if path in ("/api/guide", "/guide"):
            return self.send_text(200, read_guide())
        self.send_json(404, {"error": "not_found"})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8093"))
    signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"assistant (python) listening on {host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
