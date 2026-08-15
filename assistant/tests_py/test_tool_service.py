import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from agdevworld_assistant import tool_service

SERVICE = Path(tool_service.__file__)


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def _reply(self, body):
        if self.path == "/missing":
            status, content_type, payload = 404, "text/plain", b"no such thing"
        elif self.path == "/echo":
            status, content_type = 200, "text/plain"
            payload = f"{self.command} {self.headers.get('content-type')} {body.decode()}".encode()
        elif self.path == "/big":
            status, content_type = 200, "text/plain"
            payload = b"x" * (tool_service.MAX_BODY_BYTES + 10)
        else:
            status, content_type, payload = 202, "application/json", b'{"ok":true}'
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self._reply(b"")

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        self._reply(self.rfile.read(length))


@pytest.fixture
def origin(monkeypatch):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    monkeypatch.setenv("AGDEVWORLD_TOOL_BASE_URL", base)
    yield base
    server.shutdown()
    server.server_close()


def body_of(result):
    return result["content"][0]["text"]


def test_catalog_exposes_server_and_ui_tools():
    assert [tool["name"] for tool in tool_service.TOOLS] == ["fetch", "wait", "switch_view", "show_image"]


@pytest.mark.parametrize("path", ["//example.com/private", "example.com", ""])
def test_fetch_refuses_paths_that_do_not_begin_with_one_slash(path):
    result = tool_service.call_tool("fetch", {"path": path})
    assert result["isError"] is True
    assert "refused" in body_of(result)


def test_fetch_returns_status_content_type_and_raw_body(origin):
    result = tool_service.call_tool("fetch", {"path": "/state"})
    assert "isError" not in result
    assert body_of(result) == 'HTTP 202 application/json\n\n{"ok":true}'


def test_fetch_passes_a_404_through_as_a_normal_response(origin):
    result = tool_service.call_tool("fetch", {"path": "/missing"})
    assert "isError" not in result
    assert body_of(result) == "HTTP 404 text/plain\n\nno such thing"


def test_fetch_sends_the_json_content_type_only_with_a_body(origin):
    with_body = tool_service.call_tool("fetch", {"path": "/echo", "method": "post", "body": "{}"})
    assert body_of(with_body) == "HTTP 200 text/plain\n\nPOST application/json {}"
    without_body = tool_service.call_tool("fetch", {"path": "/echo", "method": "POST"})
    assert body_of(without_body) == "HTTP 200 text/plain\n\nPOST None "  # no content type, empty body


def test_fetch_clips_a_large_body(origin):
    result = tool_service.call_tool("fetch", {"path": "/big"})
    head, body = body_of(result).split("\n\n", 1)
    assert head == "HTTP 200 text/plain"
    assert body == "x" * tool_service.MAX_BODY_BYTES + f"\n\n[body clipped at {tool_service.MAX_BODY_BYTES} bytes]"


def test_fetch_refuses_a_method_other_than_get_or_post(origin):
    result = tool_service.call_tool("fetch", {"path": "/state", "method": "DELETE"})
    assert result["isError"] is True
    assert body_of(result) == "fetch refused: method DELETE is not GET or POST"


def test_fetch_reports_a_transport_failure_as_an_error(monkeypatch):
    monkeypatch.setenv("AGDEVWORLD_TOOL_BASE_URL", "http://127.0.0.1:1")
    result = tool_service.call_tool("fetch", {"path": "/state"})
    assert result["isError"] is True
    assert body_of(result).startswith("fetch GET /state failed: ")


def test_wait_clamps_to_sixty_seconds(monkeypatch):
    slept = []
    monkeypatch.setattr(tool_service.time, "sleep", slept.append)
    assert body_of(tool_service.call_tool("wait", {"seconds": 120})) == "waited 60 seconds (120 was requested)"
    assert body_of(tool_service.call_tool("wait", {"seconds": -3})) == "waited 0 seconds (-3 was requested)"
    assert body_of(tool_service.call_tool("wait", {"seconds": "nope"})) == "waited 0 seconds (nope was requested)"
    assert body_of(tool_service.call_tool("wait", {"seconds": 2})) == "waited 2 seconds"
    assert slept == [60, 0, 0, 2]


def test_actions_need_the_channel(monkeypatch):
    monkeypatch.delenv("AGDEVWORLD_ACTIONS_FILE", raising=False)
    result = tool_service.call_tool("switch_view", {"view": "tasks"})
    assert result["isError"] is True
    assert body_of(result) == "UI action channel is unavailable"


def test_actions_append_one_json_object_per_line(tmp_path, monkeypatch):
    actions = tmp_path / "actions.jsonl"
    monkeypatch.setenv("AGDEVWORLD_ACTIONS_FILE", str(actions))
    assert body_of(tool_service.call_tool("switch_view", {"view": "nodes"})) == "the browser will switch to nodes"
    assert body_of(tool_service.call_tool("show_image", {"url": "http://x/y.png"})) == "the browser will show http://x/y.png"
    lines = [json.loads(line) for line in actions.read_text().splitlines()]
    assert lines == [
        {"action": "switch_view", "view": "nodes"},
        {"action": "show_image", "url": "http://x/y.png"},
    ]


def test_actions_refuse_an_unknown_view_and_an_empty_url(tmp_path, monkeypatch):
    actions = tmp_path / "actions.jsonl"
    monkeypatch.setenv("AGDEVWORLD_ACTIONS_FILE", str(actions))
    view = tool_service.call_tool("switch_view", {"view": "records"})
    image = tool_service.call_tool("show_image", {})
    assert (view["isError"], body_of(view)) == (True, "unknown view: records")
    assert (image["isError"], body_of(image)) == (True, "show_image requires a URL")
    assert not actions.exists()


def test_an_unknown_tool_is_a_tool_level_error():
    result = tool_service.call_tool("rm", {})
    assert result["isError"] is True
    assert body_of(result) == "unknown tool: rm"


def test_stdio_mcp_lists_tools_and_collects_a_ui_action(tmp_path):
    actions = tmp_path / "actions.jsonl"
    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        {"jsonrpc": "2.0", "id": 3, "method": "ping"},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call",
         "params": {"name": "switch_view", "arguments": {"view": "tasks"}}},
        {"jsonrpc": "2.0", "id": 5, "method": "tools/unknown"},
    ]
    completed = subprocess.run(
        [sys.executable, str(SERVICE)],
        input="".join(json.dumps(request) + "\n" for request in requests),
        capture_output=True,
        text=True,
        env={"PATH": "/usr/bin:/bin", "AGDEVWORLD_ACTIONS_FILE": str(actions)},
        timeout=30,
    )
    assert completed.returncode == 0
    replies = [json.loads(line) for line in completed.stdout.splitlines()]
    assert [reply["id"] for reply in replies] == [1, 2, 3, 4, 5]  # the notification is silent
    assert replies[0]["result"]["serverInfo"]["name"] == "agdevworld-tools"
    assert replies[0]["result"]["protocolVersion"] == "2025-03-26"
    assert len(replies[1]["result"]["tools"]) == 4
    assert replies[2]["result"] == {}
    assert "switch to tasks" in replies[3]["result"]["content"][0]["text"]
    assert replies[4]["error"]["code"] == -32601
    assert json.loads(actions.read_text().strip()) == {"action": "switch_view", "view": "tasks"}


# --- the two entrances share one implementation ------------------------------


def test_messages_api_specs_rename_the_schema_key_and_nothing_else():
    """The Messages API says input_schema where MCP says inputSchema; the
    schemas themselves are the same objects, so a tool description written
    once serves both doors."""
    specs = tool_service.messages_api_specs()
    assert [spec["name"] for spec in specs] == [tool["name"] for tool in tool_service.TOOLS]
    for spec, mcp in zip(specs, tool_service.TOOLS):
        assert set(spec) == {"name", "description", "input_schema"}
        assert spec["description"] == mcp["description"]
        assert spec["input_schema"] == mcp["inputSchema"]


def test_result_text_flattens_a_reply_including_an_error_one():
    assert tool_service.result_text(tool_service.text("plain")) == "plain"
    assert tool_service.result_text(tool_service.text("refused", True)) == "refused"
    assert tool_service.result_text({}) == ""


def test_explicit_context_wins_over_the_environment(tmp_path, monkeypatch):
    env_file, explicit = tmp_path / "env.jsonl", tmp_path / "explicit.jsonl"
    monkeypatch.setenv("AGDEVWORLD_ACTIONS_FILE", str(env_file))

    tool_service.call_tool("switch_view", {"view": "nodes"}, actions_file=str(explicit))

    assert explicit.exists() and not env_file.exists()


def test_the_environment_still_serves_the_mcp_subprocess(tmp_path, monkeypatch):
    actions = tmp_path / "env.jsonl"
    monkeypatch.setenv("AGDEVWORLD_ACTIONS_FILE", str(actions))

    tool_service.call_tool("switch_view", {"view": "nodes"})

    assert json.loads(actions.read_text()) == {"action": "switch_view", "view": "nodes"}
