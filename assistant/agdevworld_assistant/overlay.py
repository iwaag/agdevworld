"""Generate the ignored `.local/agents.local.toml` overlay from deployment env.

The port of `overlay-generator.mjs`, pulled one phase forward: `assistant-py`
starts the module directly and so never runs `entrypoint.mjs`, which is what
writes this file for the JavaScript service. Without it the container has no
harness commands and no ollama base URL, and every chat is a clean 502.

No API key value ever enters the generated file — `anthropic_api_key_env`
names the variable, and `agag.agent_config` reads it from this process's
environment at resolution time.
"""

import json
import os
from pathlib import Path

from .settings import AGENTS_LOCAL_CONFIG


def _toml_string(value) -> str:
    return json.dumps(str(value))


def render_overlay(env=None) -> str:
    env = os.environ if env is None else env
    claude = env.get("AGENT_HARNESS_CLAUDE_CODE_COMMAND") or "/usr/local/bin/claude"
    # No `/v1` suffix: agcode posts to `{base_url}/v1/messages`, so the
    # OpenAI-compatible `/v1` path the previous harness wanted would double it.
    ollama = env.get("AGENT_PROVIDER_OLLAMA_BASE_URL") or "http://host.docker.internal:11434"
    secret_env = env.get("AGENT_ANTHROPIC_API_KEY_ENV") or "ANTHROPIC_API_KEY"
    fake = env.get("AGENT_HARNESS_FAKE_COMMAND") or "/bin/cat"
    profile = env.get("AGENT_FRONT_PROFILE") or ""
    lines = [
        'schema = "ag.agent-config.v1"',
        "",
        # agcode needs no [local.harness.agcode] block: its default command is
        # sys.executable, which is already the interpreter importing agag.
        "[local.harness.claude_code]",
        f"command = {_toml_string(claude)}",
        "",
        # `fake` has no default command in agag, so the stub profile is
        # unrunnable without one. /bin/cat returns the prompt as the reply,
        # which makes the composed prompt directly observable.
        "[local.harness.fake]",
        f"command = {_toml_string(fake)}",
        "",
        "[local.provider.ollama]",
        f"base_url = {_toml_string(ollama)}",
        "",
        "[local.secrets]",
        f"anthropic_api_key_env = {_toml_string(secret_env)}",
    ]
    if profile:
        lines += ["", "[roles.front]", f"profile = {_toml_string(profile)}"]
    return "\n".join(lines) + "\n"


def write_overlay(path: Path = AGENTS_LOCAL_CONFIG, env=None) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_overlay(env), encoding="utf-8")
    path.chmod(0o600)
    return path
