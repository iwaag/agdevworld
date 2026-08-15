"""The agdevworld tool bodies: fetch, wait, switch_view, show_image.

Two entrances, one implementation. ``serve()`` is the MCP entry point —
line-delimited JSON-RPC over stdio, standard library only, stdout carrying
JSON-RPC and nothing else — used by the `sonnet` profile through
``--mcp-config``. ``call_tool()`` is the same four tools called directly,
used by the `agcode` profile in-process (`chat.agcode_tools`).

The per-run context (the agdevworld origin to fetch from, the file UI actions
are appended to) arrives as arguments to ``call_tool``; it falls back to the
two environment variables the MCP subprocess is started with. In-process
callers pass it explicitly, because mutating ``os.environ`` in a threaded
server is a race.

Runnable both as a file and as ``python -m agdevworld_assistant.tool_service``,
so it holds no package-relative imports.
"""

import json
import math
import os
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urljoin, urlsplit

MAX_BODY_BYTES = 1_000_000
FETCH_TIMEOUT_SECONDS = 60
WAIT_CAP_SECONDS = 60
VIEWS = ("nodes", "workspaces", "autolab", "tasks")
DEFAULT_BASE_URL = "http://127.0.0.1:8090"

TOOLS = [
    {
        "name": "fetch",
        "description": "Fetch a same-origin agdevworld path. Returns the raw HTTP status, content type, and body.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path beginning with /"},
                "method": {"type": "string", "enum": ["GET", "POST"]},
                "body": {"type": "string", "description": "POST body, normally JSON"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "wait",
        "description": "Wait before polling again. One call is capped at 60 seconds.",
        "inputSchema": {
            "type": "object",
            "properties": {"seconds": {"type": "number"}},
            "required": ["seconds"],
        },
    },
    {
        "name": "switch_view",
        "description": "Ask the browser to switch to the nodes, workspaces, autolab, or tasks view.",
        "inputSchema": {
            "type": "object",
            "properties": {"view": {"type": "string", "enum": list(VIEWS)}},
            "required": ["view"],
        },
    },
    {
        "name": "show_image",
        "description": "Ask the browser to put an image URL in the conversation.",
        "inputSchema": {
            "type": "object",
            "properties": {"url": {"type": "string"}},
            "required": ["url"],
        },
    },
]

_MISSING = object()


def _number_text(value):
    """Render a number the way JavaScript interpolates it."""
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
        if value.is_integer():
            return str(int(value))
        return repr(value)
    return str(value)


def _as_text(value):
    """`String(value ?? '')` — the coercion every argument goes through."""
    if value is None:
        return ""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return _number_text(value)
    return json.dumps(value, separators=(",", ":"))


def _as_number(value):
    """`Number(value)` — NaN when it does not convert."""
    if value is _MISSING:
        return math.nan
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return 0.0
        try:
            return float(stripped)
        except ValueError:
            return math.nan
    return math.nan


def _display(value):
    """How a raw argument appears inside a message, `undefined` included."""
    if value is _MISSING:
        return "undefined"
    if value is None:
        return "null"
    return _as_text(value)


def text(value, is_error=False):
    reply = {"content": [{"type": "text", "text": value}]}
    if is_error:
        reply["isError"] = True
    return reply


def _origin(url):
    parts = urlsplit(url)
    return parts.scheme, parts.netloc


def fetch_tool(args, base_url=None):
    path = _as_text(args.get("path"))
    if not path.startswith("/") or path.startswith("//"):
        return text("fetch refused: path must begin with one /", True)
    base = base_url or os.environ.get("AGDEVWORLD_TOOL_BASE_URL") or DEFAULT_BASE_URL
    target = urljoin(base, path)
    if _origin(target) != _origin(base):
        return text("fetch refused: target must stay on the configured agdevworld origin", True)
    method = _as_text("GET" if args.get("method") is None else args["method"]).upper()
    if method not in ("GET", "POST"):
        return text(f"fetch refused: method {method} is not GET or POST", True)
    headers = {"content-type": "application/json"} if "body" in args else {}
    data = _as_text(args.get("body")).encode("utf-8") if method == "POST" else None
    if data == b"":
        # urllib stamps a form content type on any non-None body; a POST without
        # a supplied body must carry no content type at all, as `fetch()` does.
        data, headers["content-length"] = None, "0"
    request = urllib.request.Request(target, data=data, headers=headers, method=method)
    try:
        try:
            with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
                status = response.status
                content_type = response.headers.get("content-type") or ""
                body = response.read()
        except urllib.error.HTTPError as error:
            # `fetch()` hands 4xx and 5xx back as ordinary responses, and the
            # agent is meant to read the body; only transport failures are errors.
            with error:
                status = error.code
                content_type = error.headers.get("content-type") or ""
                body = error.read()
    except Exception as error:  # URLError, socket timeouts, malformed targets
        return text(f"fetch {method} {path} failed: {_reason(error)}", True)
    clipped = body[:MAX_BODY_BYTES]
    suffix = f"\n\n[body clipped at {MAX_BODY_BYTES} bytes]" if len(body) > MAX_BODY_BYTES else ""
    decoded = clipped.decode("utf-8", errors="replace")
    return text(f"HTTP {status} {content_type}\n\n{decoded}{suffix}")


def _reason(error):
    reason = getattr(error, "reason", None)
    return str(reason) if reason is not None else str(error)


def wait_tool(args):
    raw = args.get("seconds", _MISSING)
    asked = _as_number(raw)
    seconds = min(asked, WAIT_CAP_SECONDS) if math.isfinite(asked) and asked > 0 else 0
    time.sleep(seconds)
    if seconds == asked:
        return text(f"waited {_number_text(seconds)} seconds")
    return text(f"waited {_number_text(seconds)} seconds ({_display(raw)} was requested)")


def action_tool(name, args, actions_file=None):
    actions_file = actions_file or os.environ.get("AGDEVWORLD_ACTIONS_FILE") or ""
    if not actions_file:
        return text("UI action channel is unavailable", True)
    if name == "switch_view":
        view = _as_text(args.get("view"))
        if view not in VIEWS:
            return text(f"unknown view: {view}", True)
        action = {"action": name, "view": view}
        reply = f"the browser will switch to {view}"
    else:
        url = _as_text(args.get("url"))
        if not url:
            return text("show_image requires a URL", True)
        action = {"action": name, "url": url}
        reply = f"the browser will show {url}"
    with open(actions_file, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(action, separators=(",", ":")) + "\n")
    return text(reply)


def call_tool(name, args=None, *, base_url=None, actions_file=None):
    args = args if isinstance(args, dict) else {}
    if name == "fetch":
        return fetch_tool(args, base_url)
    if name == "wait":
        return wait_tool(args)
    if name in ("switch_view", "show_image"):
        return action_tool(name, args, actions_file)
    return text(f"unknown tool: {name}", True)


def result_text(reply):
    """One MCP tool reply as the plain string a non-MCP caller wants.

    The bodies already name their own failures ("fetch refused: ...",
    "unknown view: ..."), so the ``isError`` flag adds nothing a reader of the
    text does not already have.
    """
    return "".join(
        block.get("text", "")
        for block in reply.get("content", [])
        if isinstance(block, dict) and block.get("type") == "text"
    )


def messages_api_specs():
    """The four tool specs in Anthropic Messages API spelling.

    MCP says ``inputSchema``; the Messages API says ``input_schema``. The
    schemas themselves are identical, so this is a rename, not a translation.
    """
    return [
        {
            "name": tool["name"],
            "description": tool["description"],
            "input_schema": tool["inputSchema"],
        }
        for tool in TOOLS
    ]


def handle(message):
    method = message.get("method")
    if method == "initialize":
        return {
            "protocolVersion": "2025-03-26",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "agdevworld-tools", "version": "1.0.0"},
        }
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        params = message.get("params") or {}
        return call_tool(params.get("name"), params.get("arguments"))
    if method == "ping":
        return {}
    raise ValueError(f"method not found: {method}")


def serve(stdin=None, stdout=None):
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    for line in stdin:
        if not line.strip():
            continue
        message = None
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("message must be an object")
            if "id" not in message:
                continue  # a notification
            reply = {"jsonrpc": "2.0", "id": message["id"], "result": handle(message)}
        except Exception as error:
            if not isinstance(message, dict) or "id" not in message:
                continue
            reply = {
                "jsonrpc": "2.0",
                "id": message["id"],
                "error": {"code": -32601, "message": str(error)},
            }
        stdout.write(json.dumps(reply, separators=(",", ":")) + "\n")
        stdout.flush()


if __name__ == "__main__":
    serve()
