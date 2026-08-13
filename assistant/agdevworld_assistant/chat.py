"""One browser chat request: resolve `front`, shape the prompt, run it once.

Stateless. The browser owns the conversation and sends it whole; one fresh
harness process owns the complete bounded tool loop for one request. Role
resolution happens per request, so an overlay edit lands on the next chat.

No fallback: a resolution, launch or authentication failure is a 502 and a
recorded run, never a silent downgrade to another profile or harness.
"""

from dataclasses import dataclass
from pathlib import Path

from agag.agent_config import AgentConfigError, load_config, resolve_role
from agag.harness import run_harness

from .settings import AGENT_TIMEOUT_SECONDS, AGENTS_CONFIG, AGENTS_LOCAL_CONFIG, PROJECT_ROOT

ROLE = "front"

# The paths this lists are the assistant's map of the surface it can reach;
# the capability card below it says what to do with them.
ROLE_PROMPT = """You are the assistant inside agdevworld, an immersive development interface, and the human's conversational entrance to it.

Tools: fetch(path, method, body), wait(seconds), switch_view(view), show_image(url).

Paths reachable with fetch:
- /cluster/state.json, /cluster/workspaces.json, /cluster/actual.json — the live cluster snapshots (nctl drift, workspaces, actual with hardware facts). When a live one is absent the samples are /state.sample.json, /workspaces.sample.json, /actual.sample.json.
- /api/autolab/nodes — the autolab nodes this service is configured with, and whether each answers right now.
- /api/autolab/<node>/projects — projects, their current coding/director profiles, their sources, and the available profiles.
- /api/autolab/<node>/jobs, /api/autolab/<node>/jobs/<job>, /api/autolab/<node>/status — one node's autolab gateway.
- /api/autolab/<node>/jobs/<job>/summarize/<iter> — POST asks the node to summarize that iteration, GET reads the result; it takes about 15 seconds and may answer "pending".
- /api/autolab/<node>/window and /api/autolab/<node>/director — POST {"text":"..."} to a node's own conversational window, or to its director. The window is the node's entrance: asking it for work is how a mission gets started (it refuses while one is already running).
- /api/plane/issues and /api/plane/states — the default Plane project's task list and state vocabulary. /api/plane/projects/<project-uuid>/issues|states reaches any project by UUID (project starts return it). POST an issue with a state_name field; the server resolves it without exposing Plane credentials or live state IDs.
- To change a project's coding or director profile, read that node's /projects, ask its /window in ordinary words to make the change, then re-read /projects to confirm it. There is no direct settings-write route.
- /api/note — POST {"text":"..."} writes a note into this service's records; it is the one thing you can leave behind.
- /api/forge/requests — POST {"desire":"..."} starts an image generation on agforge; GET /api/forge/requests/<id> reads it back. It takes 20 to 105 seconds.
- /api/freeforge/requests — POST {"desire":"..."} posts the request as a fresh create-* topic in the #FreeForge Zulip channel; agforge answers in that topic where the Developer can watch. Returns {channel, topic, message_id}. POST /api/freeforge/resolve {"message_id":..., "topic":"..."} marks the topic resolved when the exchange is done.
- /api/autolab/projects — POST {"project":"<lowercase-hyphen name>","concept":"..."} starts a new autolab project: the autodev/<name> + <name>-direction Gitea repo pair (direction seeded), a fresh Plane project (its UUID and state ids are returned — mission briefings must carry them), and the standing #pj-<name> Zulip channel with every agent and the Developer subscribed. It creates no issue and starts no mission: development starts separately.
- /api/autolab/missions — POST {"project":"<name>","briefing":"..."} posts the briefing as a fresh mission-* topic in #pj-<name>; the autolab listener bridges it to a node window and reports the outcome in the same topic. Returns {channel, topic, message_id}. The briefing is the whole mission: include the goal, the repositories, and the Plane project/issue/state ids to report to. POST /api/autolab/missions/resolve {"message_id":..., "topic":"..."} marks the topic resolved when the mission's outcome is settled.
- /api/guide — the capability card below, raw.

The screen shows one view at a time: nodes, workspaces, autolab, tasks.

Budget: the complete agent run is bounded by the service timeout. Each wait or fetch tool call lasts at most 60 seconds. Whatever a path answers, including a refusal and its reason, is returned as-is; a path outside /api/ that does not exist answers 200 with this app's HTML rather than 404."""

VALIDATION_DETAIL = "messages must be a non-empty array of user or assistant messages."


class ChatFailure(Exception):
    """A run that produced no answer. Carries whatever identity it reached."""

    def __init__(self, message: str, meta: dict | None = None, outcome: str = "failed"):
        super().__init__(message)
        self.meta = meta or {}
        self.outcome = outcome


@dataclass
class ChatAnswer:
    reply: str
    actions: list
    meta: dict


def valid_messages(value) -> bool:
    return (
        isinstance(value, list)
        and len(value) > 0
        and all(
            isinstance(item, dict)
            and item.get("role") in ("user", "assistant")
            and isinstance(item.get("content"), str)
            for item in value
        )
    )


def compose_system(context, guide: str) -> str:
    screen = f"\n\n{context}" if isinstance(context, str) and context.strip() else ""
    return f"{ROLE_PROMPT}{screen}\n\n=== CAPABILITY CARD ===\n{guide}"


def compose_prompt(system: str, messages: list) -> str:
    history = "\n\n".join(
        f"{'ASSISTANT' if message.get('role') == 'assistant' else 'USER'}:\n"
        f"{message.get('content') or ''}"
        for message in messages
    )
    return (
        f"{system}\n\n=== CONVERSATION SUPPLIED BY THE BROWSER ===\n{history}\n\n"
        "Answer the latest USER message. Use the agdevworld tools whenever the "
        "request needs current state or a UI action."
    )


def resolve_front(config_path: Path | None = None, overlay_path: Path | None = None):
    """Resolve `front` now — an overlay edit lands on the next chat, as today."""
    try:
        config, overlay = load_config(
            config_path or AGENTS_CONFIG, overlay_path or AGENTS_LOCAL_CONFIG
        )
        return resolve_role(config, overlay, ROLE)
    except AgentConfigError as error:
        raise ChatFailure(str(error)) from error


def run_front(
    prompt: str,
    *,
    transcript_path: Path | None = None,
    config_path: Path | None = None,
    overlay_path: Path | None = None,
    timeout: float | None = None,
    cwd: Path | None = None,
) -> ChatAnswer:
    agent = resolve_front(config_path, overlay_path)
    timeout = AGENT_TIMEOUT_SECONDS if timeout is None else timeout
    cwd = cwd or PROJECT_ROOT
    result = run_harness(agent, prompt, cwd=cwd, timeout=timeout, transcript_path=transcript_path)
    # run_harness never raises for a bad run, and a zero exit code is not a
    # pass: an error envelope or empty output is a failure too. The outcome is
    # the whole verdict.
    if result.meta.get("outcome") != "done":
        raise ChatFailure(
            result.meta.get("failure") or result.output,
            result.meta,
            result.meta.get("outcome", "failed"),
        )
    # extract_event_text does not strip; the reply the browser renders should.
    return ChatAnswer(result.output.strip(), [], result.meta)
