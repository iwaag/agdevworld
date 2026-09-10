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
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from .budget import Budget
from .chat import Chat
from .close import Closer, parse_key
from .cost import Cost
from .frontdesk import FrontDesk
from .inflight import ROOTS_VARIABLE
from .ops import Ops
from .room import Room
from .settings import Settings

ROUTES = ("/healthz", "/agents", "/work", "/work?resolved=1", "/ops", "/routines", "/routines/<name>",
          "/inflight/<name>", "/cost", "/budget", "/frontdesk", "/frontdesk/<id>",
          "/frontdesk/<id>/close-plan",
          "/complete/plan?channel=<channel>&topic=<topic>",
          "/complete/history?channel=<channel>&topic=<topic>",
          "/settings", "/settings/<revision>", "/settings/<revision>/<path>")
WRITE_ROUTES = ("/ops/confirm", "/chat", "/routines/<name>/start", "/frontdesk/<id>/post",
                "/frontdesk/<id>/close", "/complete")


def make_handler(room: Room, ops: Ops | None = None, chat: Chat | None = None,
                 cost: Cost | None = None, budget: Budget | None = None,
                 desk: FrontDesk | None = None, settings: Settings | None = None,
                 closer: Closer | None = None):
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

        def do_OPTIONS(self) -> None:  # noqa: N802 (stdlib naming)
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def _with_chat(self, payload: dict) -> dict:
            """Say, in the read payload, whether this relay can answer at all.

            The view has to know before it draws a box: a chat input that
            silently refuses on submit is the same lie as an empty board.
            """
            payload["chat"] = chat.status() if chat is not None else {
                "configured": False,
                "reason": "this relay was built without a chat credential",
            }
            return payload

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
                    # `?resolved=1` lists the ✔ topics too, so a finished
                    # request can be reached for completion (`front_desk` p4).
                    query = parse_qs(urlparse(self.path).query)
                    resolved = (query.get("resolved") or ["0"])[0] in ("1", "true", "yes")
                    self._write_json(200, room.work(include_resolved=resolved))
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
                        self._write_json(200, self._with_chat(ops.routines()))
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
                        # `?resolved=hide` drops the sessions a human has ✔'d
                        # before the last three are taken; the default keeps
                        # every caller that never asked reading what it read.
                        query = parse_qs(urlparse(self.path).query)
                        hide = (query.get("resolved") or ["show"])[0] == "hide"
                        found = ops.routine(unquote(path[len("/routines/"):]),
                                            include_resolved=not hide)
                        self._write_json(404 if found.get("error") else 200,
                                         self._with_chat(found))
                elif path == "/cost":
                    # Host files only, like /inflight, so a view may poll it.
                    # The ops engine is asked for the roster and each
                    # routine's sessions — links it already holds, never a
                    # Zulip read — so without it the board still comes back,
                    # without the routine section, and says so.
                    if cost is None:
                        self._write_json(503, {
                            "error": "the cost gauge is not configured; "
                                     f"set {ROOTS_VARIABLE} to the instance roots on this host",
                        })
                    else:
                        roster: list[str] = []
                        sessions: dict[str, list[dict]] = {}
                        note = None
                        if ops is not None:
                            board = ops.snapshot()
                            roster = [one["instance"] for one in board["instances"]]
                            for row in ops.routines()["routines"]:
                                found = ops.routine(row["name"])
                                sessions[row["name"]] = found.get("sessions") or []
                        else:
                            note = "no ops engine: routine sessions and the roster are not known"
                        payload = cost.board(roster=roster, routine_sessions=sessions)
                        payload["note"] = note
                        self._write_json(200, payload)
                elif path == "/budget":
                    # Its own route, not folded into /cost: this one calls the
                    # vendors (through the CLIs' own reads), and /cost is
                    # stat-only and polled at 20 s. The per-provider cache in
                    # budget.py is what limits the vendor calls, not the page.
                    if budget is None:
                        self._write_json(503, {"error": "the budget read is not configured"})
                    else:
                        self._write_json(200, budget.snapshot())
                elif path == "/frontdesk":
                    # The Front Desk's conversations (`front_desk` p1). The
                    # engine's memory when it has them, the realm when not;
                    # the payload says which, and `unknown` when neither.
                    if desk is None:
                        self._write_json(503, {"error": "the Front Desk is not configured"})
                    else:
                        self._write_json(200, desk.board())
                elif path.startswith("/frontdesk/") and path.endswith("/close-plan"):
                    # What closing this conversation would change (`front_desk`
                    # p3). A read: it touches Zulip and writes nothing, and
                    # it is the *only* thing the button's final
                    # click approves. Since p4 the Front Desk is one caller of
                    # the shared operation below; its id names the topic.
                    if closer is None:
                        self._write_json(503, {"error": "conversation completion is not configured"})
                    else:
                        ident = unquote(path[len("/frontdesk/"):-len("/close-plan")])
                        found = closer.plan(Closer.desk_key(ident))
                        self._write_json(400 if found.get("error") else 200, found)
                elif path == "/complete/plan" or path == "/complete/history":
                    # The shared completion preview for any selected request
                    # (`front_desk` p4): `?channel=…&topic=…`. History is the
                    # relay's own memory of what it carried out, per request
                    # or for all of them when neither is named.
                    if closer is None:
                        self._write_json(503, {"error": "conversation completion is not configured"})
                    else:
                        query = parse_qs(urlparse(self.path).query)
                        channel = (query.get("channel") or [None])[0]
                        topic = (query.get("topic") or [None])[0]
                        if path == "/complete/history" and channel is None and topic is None:
                            self._write_json(200, {"history": closer.records()})
                        else:
                            key = parse_key(channel, topic)
                            if isinstance(key, dict):
                                self._write_json(400, key)
                            elif path == "/complete/history":
                                self._write_json(200, {"channel": key[0], "topic": key[1],
                                                       "history": closer.records(key)})
                            else:
                                found = closer.plan(key)
                                self._write_json(400 if found.get("error") else 200, found)
                elif path.startswith("/frontdesk/"):
                    if desk is None:
                        self._write_json(503, {"error": "the Front Desk is not configured"})
                    else:
                        found = desk.conversation(unquote(path[len("/frontdesk/"):]))
                        self._write_json(400 if found.get("error") else 200, found)
                elif path == "/settings" or path.startswith("/settings/"):
                    self._settings(unquote(path[len("/settings"):]).lstrip("/"))
                elif path.startswith("/inflight/"):
                    # The one route a view may poll at a few seconds. It reads
                    # this host's directories and never Zulip.
                    if ops is None:
                        self._write_json(503, {
                            "error": "the ops engine is not configured; "
                                     "set OPSROOM_ZULIP_ENV to its own bot credential",
                        })
                    else:
                        self._write_json(200, ops.inflight(unquote(path[len("/inflight/"):])))
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
                # No body at all is the common case for confirm — the view's
                # one button means "all of them" — so an empty request is not
                # an error here.
                body = json.loads(raw) if raw.strip() else {}
            except (ValueError, json.JSONDecodeError) as error:
                self._write_json(400, {"error": f"unreadable body: {error}"})
                return None
            if not isinstance(body, dict):
                self._write_json(400, {"error": "body must be a JSON object"})
                return None
            return body

        def _chat(self) -> None:
            """The one route that writes to the realm (`operation_room` p3).

            Every refusal is decided in `chat.py` and answered as 403: the
            request was well formed and the *rule* is what declined it. A view
            that forgot to hide the box therefore still cannot post into
            another agent's channel.
            """
            if chat is None or not chat.configured:
                reason = (chat.status()["reason"] if chat else
                          "this relay was built without a chat credential")
                self._write_json(503, {"error": reason})
                return
            if ops is None:
                self._write_json(503, {
                    "error": "the ops engine is not configured, so no routine is known "
                             "and nothing can be posted into one",
                })
                return
            body = self._body()
            if body is None:
                return
            channel = str(body.get("channel") or "")
            topic = str(body.get("topic") or "")
            text = str(body.get("text") or "")
            names = {row["name"] for row in ops.routines()["routines"]}
            refused = chat.check(channel, topic, text, names)
            if refused is not None:
                self._write_json(403, {"sent": False, "error": refused})
                return
            try:
                found = chat.send(channel, topic, text, names)
            except Exception as error:
                # No retry: the post may well have landed, and a second one
                # buys a second paid run for a thing the human asked once.
                self._write_json(502, {"sent": False,
                                       "error": f"{type(error).__name__}: {error}"})
                return
            self._write_json(200, found)

        def _start(self, name: str) -> None:
            """Ask Front to run a routine (`refine_routine` p1 step 4).

            The same door as `/chat` — the Developer's credential — posting
            the request at Front's ordinary entrance, a Front Desk
            conversation of its own; Front reads the guide and opens the run.
            Refusals are 409 because the request was well formed and the
            routine's *state* declined it.
            """
            if chat is None or not chat.configured:
                reason = (chat.status()["reason"] if chat else
                          "this relay was built without a chat credential")
                self._write_json(503, {"sent": False, "uncertain": False, "error": reason})
                return
            if ops is None:
                self._write_json(503, {
                    "sent": False, "uncertain": False,
                    "error": "the ops engine is not configured, so no routine is known",
                })
                return
            body = self._body()
            if body is None:
                return
            instruction = body.get("instruction")
            if instruction is not None and not isinstance(instruction, str):
                self._write_json(400, {"error": "instruction must be a string"})
                return
            rows = ops.routines()["routines"]
            row = next((one for one in rows if one["name"] == name), None)
            # A Front Desk conversation id, the way the desk screen mints
            # them, so the request is a conversation the desk can show.
            stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
            found = chat.request(row, name, instruction, stamp=stamp)
            if found["sent"]:
                self._write_json(200, found)
            elif found.get("uncertain"):
                self._write_json(502, found)
            else:
                self._write_json(409, found)

        def _desk_post(self, ident: str) -> None:
            """The Front Desk's write: as the Developer, into
            `#front` › `front-desk-<id>`, once per submit token."""
            if desk is None:
                self._write_json(503, {"sent": False, "error": "the Front Desk is not configured"})
                return
            if chat is None or not chat.configured:
                reason = (chat.status()["reason"] if chat else
                          "this relay was built without a chat credential")
                self._write_json(503, {"sent": False, "uncertain": False, "error": reason})
                return
            body = self._body()
            if body is None:
                return
            text = str(body.get("text") or "")
            token = str(body.get("token") or "")
            refused = desk.check(ident, text, token)
            if refused is not None:
                self._write_json(403, {"sent": False, "uncertain": False, "error": refused})
                return
            found = desk.post(ident, text, token)
            if found.get("sent"):
                self._write_json(200, found)
            elif found.get("uncertain"):
                self._write_json(502, found)
            else:
                self._write_json(403, found)

        def _complete(self, key) -> None:
            """Close the selected request and the work it opened.

            The body carries the fingerprint of the preview the human
            approved — never a list of destinations. The targets are
            re-derived here, and a plan that no longer matches is answered
            409 with the fresh one rather than written against. `key` is what
            the route named, or the refusal it produced instead.
            """
            if closer is None:
                self._write_json(503, {"error": "conversation completion is not configured"})
                return
            body = self._body()
            if body is None:
                return
            if key is None:
                key = parse_key(body.get("channel"), body.get("topic"))
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
                # The realm changed: the room's cached boards are stale and
                # the view reloads them right after this answer.
                room.forget()
                self._write_json(200, found)

        def do_POST(self) -> None:  # noqa: N802
            path = urlparse(self.path).path.rstrip("/") or "/"
            if path == "/chat":
                self._chat()
                return
            if path.startswith("/frontdesk/") and path.endswith("/post"):
                self._desk_post(unquote(path[len("/frontdesk/"):-len("/post")]))
                return
            if path.startswith("/frontdesk/") and path.endswith("/close"):
                ident = unquote(path[len("/frontdesk/"):-len("/close")])
                self._complete(Closer.desk_key(ident))
                return
            if path == "/complete":
                self._complete(None)
                return
            if path.startswith("/routines/") and path.endswith("/start"):
                self._start(unquote(path[len("/routines/"):-len("/start")]))
                return
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
            body = self._body()
            if body is None:
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


def build_server(
    host: str, port: int, room: Room, ops: Ops | None = None, chat: Chat | None = None,
    cost: Cost | None = None, budget: Budget | None = None, desk: FrontDesk | None = None,
    settings: Settings | None = None, closer: Closer | None = None,
) -> ThreadingHTTPServer:
    return ThreadingHTTPServer(
        (host, port), make_handler(room, ops, chat, cost, budget, desk, settings, closer)
    )
