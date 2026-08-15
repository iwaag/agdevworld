"""The chat request: shaping, validation, and one real stub round trip.

The `stub` profile runs `/bin/cat`, so the harness hands the composed prompt
straight back. That makes the prompt the assistant would send an assertable
value rather than something only a model sees.
"""

import json
from collections import namedtuple
from pathlib import Path

import pytest

from agdevworld_assistant import chat, records, server

# `_launch_conditions` reads exactly one field of the resolved agent.
FakeAgent = namedtuple("FakeAgent", "harness")

AGENTS_TOML = """\
schema = "ag.agent-config.v1"
project = "agdevworld-test"

[models."ollama/test-model"]

[profiles.stub]
harness = "fake"
model = "ollama/test-model"

[roles.front]
profile = "stub"
requires = ["ui_actions"]

[capabilities]
provides = ["ui_actions"]
"""


def overlay_for(command):
    return f'schema = "ag.agent-config.v1"\n\n[local.harness.fake]\ncommand = "{command}"\n'


@pytest.fixture
def stub_config(tmp_path):
    """A committed config plus an overlay, both temporary."""

    def make(command="/bin/cat"):
        config = tmp_path / "agents.toml"
        overlay = tmp_path / "agents.local.toml"
        config.write_text(AGENTS_TOML)
        overlay.write_text(overlay_for(command))
        return {"config_path": config, "overlay_path": overlay}

    return make


# --- shaping ---------------------------------------------------------------


def test_system_carries_the_screen_only_when_there_is_one():
    with_screen = chat.compose_system("the tasks view is open", "CARD")
    assert "\n\nthe tasks view is open\n\n=== CAPABILITY CARD ===\nCARD" in with_screen
    assert with_screen.startswith(chat.ROLE_PROMPT)
    for empty in (None, "", "   ", 7):
        assert chat.compose_system(empty, "CARD") == f"{chat.ROLE_PROMPT}\n\n=== CAPABILITY CARD ===\nCARD"


def test_prompt_blocks_the_conversation_and_ends_with_the_instruction():
    prompt = chat.compose_prompt("SYSTEM", [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi"},
        {"role": "user", "content": "what is on screen?"},
    ])
    assert prompt.startswith("SYSTEM\n\n=== CONVERSATION SUPPLIED BY THE BROWSER ===\n")
    assert "USER:\nhello\n\nASSISTANT:\nhi\n\nUSER:\nwhat is on screen?" in prompt
    assert prompt.endswith("Answer the latest USER message. Use the agdevworld tools "
                           "whenever the request needs current state or a UI action.")


# --- validation ------------------------------------------------------------


@pytest.mark.parametrize("messages", [
    None, [], "hello", {}, [{"role": "user"}],
    [{"role": "system", "content": "x"}],
    [{"role": "user", "content": 7}],
    [{"role": "user", "content": "ok"}, "not a message"],
])
def test_bad_message_arrays_are_rejected_before_any_run(messages):
    code, body = server.handle_chat({"messages": messages})
    assert code == 400
    assert body["error"] == "bad_request"


def test_a_valid_array_passes_validation():
    assert chat.valid_messages([{"role": "user", "content": ""}])


# --- the stub round trip ---------------------------------------------------


def test_stub_returns_the_composed_prompt(stub_config, tmp_path):
    prompt = chat.compose_prompt("SYSTEM", [{"role": "user", "content": "say something"}])
    transcript = tmp_path / "run.agent.jsonl"
    answer = chat.run_front(prompt, transcript_path=transcript, timeout=30, **stub_config())
    assert answer.reply == prompt
    assert answer.meta["profile"] == "stub"
    assert answer.meta["harness"] == "fake"
    assert answer.meta["outcome"] == "done"
    assert transcript.read_text() == prompt


def test_chat_records_a_done_run(monkeypatch, stub_config, tmp_path):
    paths = stub_config()
    monkeypatch.setattr(chat, "AGENTS_CONFIG", paths["config_path"])
    monkeypatch.setattr(chat, "AGENTS_LOCAL_CONFIG", paths["overlay_path"])
    monkeypatch.setattr(records, "RECORDS_DIR", tmp_path / "records")
    monkeypatch.setattr(server, "RECORDS_DIR", tmp_path / "records")

    code, body = server.handle_chat({"messages": [{"role": "user", "content": "hello"}],
                                     "context": "the nodes view is open"})
    assert code == 200
    assert body["run"] == {"id": body["run"]["id"], "role": "front", "profile": "stub",
                           "harness": "fake", "provider": "ollama", "model": "ollama/test-model",
                           "outcome": "done"}
    assert body["actions"] == []
    assert "the nodes view is open" in body["reply"]
    assert "hello" in body["reply"]

    written = json.loads((tmp_path / "records" / f"{body['run']['id']}.json").read_text())
    assert written["schema"] == "ag.agent-run.v1"
    assert written["outcome"] == "done"
    assert written["actions"] == []
    assert written["started"].endswith("Z")
    assert written["model"] == "ollama/test-model"
    assert written["duration_ms"] >= 0


def failing_command(tmp_path):
    """A command that exists and exits 1. (`/bin/false` is macOS-absent.)"""
    script = tmp_path / "failing.sh"
    script.write_text("#!/bin/sh\nexit 1\n")
    script.chmod(0o755)
    return str(script)


def test_a_failed_run_is_a_502_and_a_record(monkeypatch, stub_config, tmp_path):
    paths = stub_config(failing_command(tmp_path))
    monkeypatch.setattr(chat, "AGENTS_CONFIG", paths["config_path"])
    monkeypatch.setattr(chat, "AGENTS_LOCAL_CONFIG", paths["overlay_path"])
    monkeypatch.setattr(records, "RECORDS_DIR", tmp_path / "records")
    monkeypatch.setattr(server, "RECORDS_DIR", tmp_path / "records")

    code, body = server.handle_chat({"messages": [{"role": "user", "content": "hello"}]})
    assert code == 502
    assert body["error"] == "assistant_offline"

    written = json.loads(next((tmp_path / "records").glob("*.json")).read_text())
    assert written["outcome"] == "failed"
    assert written["profile"] == "stub"
    assert "exited 1" in written["failure"]


def test_an_unresolvable_role_is_a_502_before_any_launch(monkeypatch, tmp_path):
    missing = tmp_path / "no-such-agents.toml"
    monkeypatch.setattr(chat, "AGENTS_CONFIG", missing)
    monkeypatch.setattr(chat, "AGENTS_LOCAL_CONFIG", tmp_path / "no-such-overlay.toml")
    monkeypatch.setattr(records, "RECORDS_DIR", tmp_path / "records")
    monkeypatch.setattr(server, "RECORDS_DIR", tmp_path / "records")

    code, body = server.handle_chat({"messages": [{"role": "user", "content": "hello"}]})
    assert code == 502
    assert "E_SCHEMA" in body["detail"]
    written = json.loads(next((tmp_path / "records").glob("*.json")).read_text())
    assert written["outcome"] == "failed"
    assert "harness" not in written  # nothing was resolved, so nothing is claimed


# --- the per-run launch conditions -----------------------------------------


def test_the_run_gets_its_own_actions_file_and_tool_base_url(stub_config, tmp_path):
    """The two per-run variables reach the process, and what it appends to the
    actions file comes back as actions. A shell script stands in for a harness."""
    command = tmp_path / "acting.sh"
    command.write_text(
        "#!/bin/sh\n"
        "cat > /dev/null\n"
        'printf \'{"action":"switch_view","view":"tasks"}\\n\' >> "$AGDEVWORLD_ACTIONS_FILE"\n'
        'printf \'bad line\\n\' >> "$AGDEVWORLD_ACTIONS_FILE"\n'
        'echo "reached $AGDEVWORLD_TOOL_BASE_URL"\n'
    )
    command.chmod(0o755)
    answer = chat.run_front("prompt", timeout=30, tool_base_url="http://web",
                            **stub_config(str(command)))
    assert answer.reply == "reached http://web"
    assert answer.actions == [{"action": "switch_view", "view": "tasks"}]  # the bad line is skipped


def test_the_actions_file_does_not_outlive_the_run(stub_config, tmp_path):
    command = tmp_path / "leaking.sh"
    command.write_text('#!/bin/sh\ncat > /dev/null\necho "$AGDEVWORLD_ACTIONS_FILE"\n')
    command.chmod(0o755)
    answer = chat.run_front("prompt", timeout=30, **stub_config(str(command)))
    path = Path(answer.reply)
    assert not path.exists()
    assert not path.parent.exists()


# --- the agcode door -------------------------------------------------------


def test_agcode_tools_are_the_four_with_messages_api_schemas(tmp_path):
    tools = chat.agcode_tools(tool_base_url="http://web", actions_file=tmp_path / "a.jsonl")
    assert [tool.name for tool in tools] == ["fetch", "wait", "switch_view", "show_image"]
    for tool in tools:
        # Messages API spelling, not MCP's inputSchema.
        assert set(tool.spec) == {"name", "description", "input_schema"}


def test_agcode_switch_view_appends_to_the_run_actions_file(tmp_path):
    actions = tmp_path / "actions.jsonl"
    tools = {t.name: t for t in chat.agcode_tools(tool_base_url="http://web", actions_file=actions)}

    # agcode calls func(working_dir, **arguments); the working directory is
    # ignored — the actions file arrives by absolute path.
    reply = tools["switch_view"].func(tmp_path, view="tasks")

    assert reply == "the browser will switch to tasks"
    assert json.loads(actions.read_text()) == {"action": "switch_view", "view": "tasks"}


def test_agcode_tool_context_is_per_call_not_environment(tmp_path, monkeypatch):
    """The in-process door must not depend on os.environ: two concurrent runs
    in one threaded server would race on it."""
    monkeypatch.delenv("AGDEVWORLD_ACTIONS_FILE", raising=False)
    monkeypatch.delenv("AGDEVWORLD_TOOL_BASE_URL", raising=False)
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    tools_a = {t.name: t for t in chat.agcode_tools(tool_base_url="http://web", actions_file=a)}
    tools_b = {t.name: t for t in chat.agcode_tools(tool_base_url="http://web", actions_file=b)}

    tools_a["show_image"].func(tmp_path, url="http://x/1.png")
    tools_b["show_image"].func(tmp_path, url="http://x/2.png")

    assert json.loads(a.read_text())["url"] == "http://x/1.png"
    assert json.loads(b.read_text())["url"] == "http://x/2.png"


def test_agcode_tool_reports_a_refusal_as_its_own_text(tmp_path):
    tools = {t.name: t for t in chat.agcode_tools(tool_base_url="http://web", actions_file=tmp_path / "a")}
    assert "unknown view: elsewhere" in tools["switch_view"].func(tmp_path, view="elsewhere")
    assert "fetch refused" in tools["fetch"].func(tmp_path, path="no-leading-slash")


def test_agcode_profile_never_reaches_run_harness(monkeypatch, tmp_path):
    """`run_front` routes agcode in-process; nothing is launched as a
    subprocess and no per-run environment variable is set."""
    agent = namedtuple("A", "harness provider_base_url native_model role profile provider model")(
        "agcode", "http://ollama", "test-model", "front", "local", "ollama", "ollama/test-model"
    )
    monkeypatch.setattr(chat, "resolve_front", lambda *a, **k: agent)
    monkeypatch.setattr(chat, "run_harness", lambda *a, **k: pytest.fail("run_harness was called"))
    seen = {}

    def fake_run(prompt, working_dir, **kwargs):
        seen.update(prompt=prompt, working_dir=working_dir, **kwargs)
        return chat.agcode.AgcodeResult("the reply", "ok", {"outcome": "done", "num_turns": 1})

    monkeypatch.setattr(chat.agcode, "run", fake_run)
    answer = chat.run_front("prompt", timeout=42, tool_base_url="http://web")

    assert answer.reply == "the reply"
    assert answer.meta["harness"] == "agcode"        # identity comes from the agent
    assert answer.meta["model"] == "ollama/test-model"  # canonical, not native
    assert seen["model"] == "test-model"             # native, for the wire
    assert seen["base_url"] == "http://ollama"
    assert seen["deadline_s"] == 42
    assert [t.name for t in seen["tools"]] == ["fetch", "wait", "switch_view", "show_image"]
    # The working directory is the per-run temp dir, gone by now: exactly one
    # base, and nothing of the checkout is reachable through it.
    assert not Path(seen["working_dir"]).exists()


def test_a_failed_agcode_run_is_still_a_chat_failure(monkeypatch):
    agent = namedtuple("A", "harness provider_base_url native_model role profile provider model")(
        "agcode", "http://ollama", "test-model", "front", "local", "ollama", "ollama/test-model"
    )
    monkeypatch.setattr(chat, "resolve_front", lambda *a, **k: agent)
    monkeypatch.setattr(chat.agcode, "run", lambda *a, **k: chat.agcode.AgcodeResult(
        "", "aborted", {"outcome": "aborted", "failure": "deadline_exceeded: out of time"}
    ))

    with pytest.raises(chat.ChatFailure) as error:
        chat.run_front("prompt", timeout=1)
    assert error.value.outcome == "aborted"
    assert "deadline_exceeded" in str(error.value)


def test_non_claude_harness_runs_from_the_project_root_with_no_extra_argv():
    cwd, conditions = chat._launch_conditions(FakeAgent("fake"), Path("/tmp/unused"))
    assert cwd == chat.PROJECT_ROOT
    assert conditions == {}


def test_claude_code_carries_its_mcp_config_in_argv(tmp_path):
    cwd, conditions = chat._launch_conditions(FakeAgent("claude_code"), tmp_path)
    assert cwd == tmp_path
    config = tmp_path / "claude-mcp.json"
    assert conditions["extra_args"] == ["--mcp-config", str(config), "--strict-mcp-config"]
    assert conditions["allowed_tools"] == (
        "mcp__agdevworld__fetch,mcp__agdevworld__wait,"
        "mcp__agdevworld__switch_view,mcp__agdevworld__show_image"
    )
    assert "--model" not in conditions["extra_args"]  # agag raises on it; the profile owns it
    server_config = json.loads(config.read_text())["mcpServers"]["agdevworld"]
    assert server_config["command"] == chat.TOOL_SERVICE_PYTHON
    assert Path(server_config["args"][0]).is_absolute()
    assert Path(server_config["args"][0]).name == "tool_service.py"


# --- notes -----------------------------------------------------------------


def test_note_writes_a_record(monkeypatch, tmp_path):
    monkeypatch.setattr(records, "RECORDS_DIR", tmp_path / "records")
    code, body = server.handle_note({"text": "the card says /api/x, which 404s"})
    assert code == 201
    assert body["kind"] == "assistant.note.v1"
    written = json.loads((tmp_path / "records" / f"{body['id']}.note.json").read_text())
    assert written["text"] == "the card says /api/x, which 404s"


@pytest.mark.parametrize("payload", [{}, {"text": ""}, {"text": "  "}, {"text": 7}, None])
def test_empty_notes_are_rejected(payload):
    code, body = server.handle_note(payload)
    assert code == 400
    assert body["error"] == "bad_request"
