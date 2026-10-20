"""The relay's HTTP door: stdlib, unauthenticated, on the LAN.

Modelled on cagent's *window* listener
(`pj-clusterintent/cagent/src/cagent_api/server.py`): `ThreadingHTTPServer`,
no framework, no auth, in a private lab.

Since retire_old_ui p1 it serves the Front Desk's panels (settings, contexts,
progress), the Arguing Room (history and closing an argue), and the reads the
workflow editor's Usage view takes from this host (`/budget`, and `/cost` as
pre-WFE history). The agent room, the operation room, the routine dashboard,
the cost gauge page and their routes are gone.

CORS is answered permissively: there is nothing here to protect from a page
that can already reach the port.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from agag.mirror import Mirror

from .budget import Budget
from .chat import Chat
from .close import Closer
from .contexts import Contexts, ContextsError
from .cost import ROOTS_VARIABLE, Cost
from .argueroom import ArguingRoom
from .progress import Progress
from .room import health_block
from .settings import Settings

ROUTES = ("/healthz", "/cost", "/budget", "/argues", "/argues/<anchor>",
          "/argues/<anchor>/close-plan", "/progress?current=<desk id>",
          "/settings", "/settings/<revision>", "/settings/<revision>/<path>",
          "/contexts", "/contexts/<id>/resolve?rev=<rev>", "/contexts/<id>/tree?rev=<rev>",
          "/contexts/<id>/file?rev=<rev>&path=<path>")
WRITE_ROUTES = ("/argues/<anchor>/close",
                "/contexts", "/contexts/register", "/contexts/<id>", "/contexts/<id>/publish")


def make_handler(mirror: Mirror | None = None, chat: Chat | None = None,
                 cost: Cost | None = None, budget: Budget | None = None,
                 settings: Settings | None = None, closer: Closer | None = None,
                 argues: ArguingRoom | None = None, contexts: Contexts | None = None,
                 progress: Progress | None = None):
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

        def _write_bytes(self, status: int, body: bytes, content_type: str, *, immutable: bool = False) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            if immutable:
                # The URL carries the revision, so what it names never
                # changes: a replaced portrait is a new URL, and a browser may
                # keep this one for as long as it likes.
                self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            self.end_headers()
            self.wfile.write(body)

        def _settings(self, rest: str) -> None:
            """The settings repository's active revision, a retained one, or
            one file a manifest names (`front_desk` p2 step 1)."""
            if settings is None:
                self._write_json(503, {"error": "the settings repository is not configured"})
                return
            if rest == "":
                self._write_json(200, settings.snapshot())
                return
            revision, _, relpath = rest.partition("/")
            if relpath == "":
                found = settings.revision(revision)
                self._write_json(200 if found.get("retained") else 404, found)
                return
            asset = settings.asset(revision, relpath)
            if asset is None:
                self._write_json(404, {"error": f"revision {revision[:12]} does not retain {relpath!r}, "
                                                "or the manifest does not name it"})
                return
            body, content_type = asset
            self._write_bytes(200, body, content_type, immutable=True)

        def _contexts_error(self, error: ContextsError) -> None:
            self._write_json(error.status, {"error": str(error), **error.extra})

        def _contexts_get(self, path: str) -> None:
            """Context repositories (`give_context_easier` p1): the catalog
            with each source's newest publication, one source's tree and
            README at a revision, one file's bytes, or a revision resolved to
            its full commit for a reference."""
            if contexts is None:
                self._write_json(503, {"error": "context repositories are not configured"})
                return
            query = parse_qs(urlparse(self.path).query)
            one = lambda key, default=None: (query.get(key) or [default])[0]  # noqa: E731
            try:
                if path == "/contexts":
                    self._write_json(200, contexts.board(
                        include_archived=one("all", "0") in ("1", "true", "yes"),
                        refresh=one("refresh", "0") in ("1", "true", "yes")))
                    return
                ident, _, verb = path[len("/contexts/"):].partition("/")
                ident = unquote(ident)
                if verb == "resolve":
                    self._write_json(200, contexts.resolve(ident, one("rev", "latest")))
                elif verb == "tree":
                    self._write_json(200, contexts.tree(ident, one("rev", "latest")))
                elif verb == "file":
                    revision = one("rev", "latest")
                    body, kind, sha = contexts.file(ident, revision, one("path", ""))
                    # A full commit in the URL names bytes that never change.
                    self._write_bytes(200, body, kind, immutable=revision == sha)
                else:
                    self._write_json(404, {"error": f"no route {path}", "routes": list(ROUTES)})
            except ContextsError as error:
                self._contexts_error(error)

        def _contexts_post(self, path: str) -> None:
            """The Developer's context writes: create, register, edit the
            catalog entry, publish files. No model run; each is one relay
            operation on the Developer's Gitea token."""
            if contexts is None:
                self._write_json(503, {"error": "context repositories are not configured"})
                return
            body = self._body()
            if body is None:
                return
            try:
                if path == "/contexts":
                    self._write_json(200, contexts.create(body))
                elif path == "/contexts/register":
                    self._write_json(200, contexts.register(body))
                elif path.endswith("/publish"):
                    self._write_json(200, contexts.publish(unquote(path[len("/contexts/"):-len("/publish")]), body))
                else:
                    ident = unquote(path[len("/contexts/"):])
                    if "/" in ident:
                        self._write_json(404, {"error": f"no POST route {path}", "post": list(WRITE_ROUTES)})
                        return
                    self._write_json(200, contexts.update(ident, body))
            except ContextsError as error:
                self._contexts_error(error)

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
                    self._write_json(200, {"ok": True, "mirror": health_block(mirror)})
                elif path == "/":
                    self._write_json(200, {
                        "service": "agentroom",
                        "routes": list(ROUTES),
                        "post": list(WRITE_ROUTES),
                    })
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
                elif path == "/argues" or path.startswith("/argues/"):
                    # The Arguing Room (`argue` p2): the list, or one argue
                    # by its anchor message id, from the mirror.
                    if argues is None:
                        self._write_json(503, {"error": "the Arguing Room is not configured"})
                    elif path == "/argues":
                        self._write_json(200, argues.board())
                    elif path.endswith("/close-plan"):
                        # What closing this argue would change (`argue` p2
                        # ex1): the completion preview, keyed by the topic
                        # the anchor is in now. A read; nothing moves.
                        if closer is None:
                            self._write_json(503, {"error": "conversation completion is not configured"})
                        else:
                            key = argues.completion_key(unquote(path[len("/argues/"):-len("/close-plan")]))
                            found = closer.plan(key)
                            self._write_json(400 if found.get("error") else 200, found)
                    else:
                        found = argues.argue(unquote(path[len("/argues/"):]))
                        self._write_json(404 if found.get("error") else 200, found)
                elif path == "/progress":
                    # The Front Desk's progress panel (`progress_panel` p1):
                    # every request in flight as a card, off the mirror,
                    # Observer's records and the owners' health checks. A
                    # read: it writes nothing and starts nothing.
                    if progress is None:
                        self._write_json(503, {"error": "the progress read is not configured"})
                    else:
                        query = parse_qs(urlparse(self.path).query)
                        current = (query.get("current") or [None])[0]
                        fresh = (query.get("fresh") or ["0"])[0] in ("1", "true", "yes")
                        self._write_json(200, progress.board(current, fresh=fresh))
                elif path == "/contexts" or path.startswith("/contexts/"):
                    self._contexts_get(path)
                elif path == "/settings" or path.startswith("/settings/"):
                    self._settings(unquote(path[len("/settings"):]).lstrip("/"))
                else:
                    self._write_json(404, {"error": f"no route {path}", "routes": list(ROUTES)})
            except Exception as error:
                # A Zulip outage is the expected failure here, and the view
                # says so rather than rendering an empty room.
                self._write_json(502, {"error": f"{type(error).__name__}: {error}"})

        def _body(self) -> dict | None:
            """The request's JSON object, or None once an error is written."""
            try:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length > 0 else b""
                body = json.loads(raw) if raw.strip() else {}
            except (ValueError, json.JSONDecodeError) as error:
                self._write_json(400, {"error": f"unreadable body: {error}"})
                return None
            if not isinstance(body, dict):
                self._write_json(400, {"error": "body must be a JSON object"})
                return None
            return body

        def _complete(self, key) -> None:
            """Close the selected request and the work it opened.

            The body carries the fingerprint of the preview the human
            approved — never a list of destinations. The targets are
            re-derived here, and a plan that no longer matches is answered
            409 with the fresh one rather than written against. `key` is the
            argue's topic, or the refusal naming it produced instead.
            """
            if closer is None:
                self._write_json(503, {"error": "conversation completion is not configured"})
                return
            body = self._body()
            if body is None:
                return
            if isinstance(key, dict):
                self._write_json(400, key)
                return
            expected = body.get("fingerprint")
            if expected is not None and not isinstance(expected, str):
                self._write_json(400, {"error": "fingerprint must be the string the plan carried"})
                return
            found = closer.close(key, expected)
            if found.get("error") and not found.get("refused"):
                self._write_json(503, found)
            elif found.get("refused"):
                self._write_json(409, found)
            else:
                # The realm changed, and the mirror carries the change back
                # as events; the answer above waited for them, so the view's
                # reload right after this reads the new state from the copy.
                self._write_json(200, found)

        def do_POST(self) -> None:  # noqa: N802
            path = urlparse(self.path).path.rstrip("/") or "/"
            if path == "/contexts" or path.startswith("/contexts/"):
                self._contexts_post(path)
            elif path.startswith("/argues/") and path.endswith("/close"):
                # Closing an argue from the room, named by its anchor
                # (`argue` p2 ex1).
                if argues is None:
                    self._write_json(503, {"error": "the Arguing Room is not configured"})
                else:
                    self._complete(argues.completion_key(unquote(path[len("/argues/"):-len("/close")])))
            else:
                self._write_json(404, {"error": f"no POST route {path}", "post": list(WRITE_ROUTES)})

    return Handler


def build_server(
    host: str, port: int, mirror: Mirror | None = None, chat: Chat | None = None,
    cost: Cost | None = None, budget: Budget | None = None, settings: Settings | None = None,
    closer: Closer | None = None, argues: ArguingRoom | None = None,
    contexts: Contexts | None = None, progress: Progress | None = None,
) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(
        (host, port), make_handler(mirror, chat, cost, budget, settings, closer, argues,
                                   contexts=contexts, progress=progress)
    )
