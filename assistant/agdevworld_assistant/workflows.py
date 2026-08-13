"""The Zulip-backed workflows: freeforge requests and autolab missions.

Ports of `handleFreeForge` and the missions half of `handleAutolabWorkflow`
(server.mjs), with the client itself delegated to `agag.zulip.ZulipClient` —
this is the roadmap's payoff step, `zulip.mjs` mostly evaporates. What stays
here is only what agag does not give:

- the stamped topic names (`create-*` for freeforge, `mission-*` for
  missions; one disposable topic per request in a standing channel);
- the active-user filter (`users()` returns deactivated members too);
- the one retry on a socket-level failure: the first call right after a
  container start has been seen to lose its TLS socket while Zulip itself was
  fine. HTTP-level errors are not retried.

The client is constructed lazily on first use: the server must boot and serve
chat without the credentials mount — tests depend on that. Credentials are
the mounted /run/secrets/zulip.env (ZULIP_URL, ZULIP_EMAIL, ZULIP_API_KEY);
the realm's certificate is self-signed, which `agag.zulip` already tolerates.
"""

from __future__ import annotations

import os
import re
import secrets
import sys
from datetime import datetime
from pathlib import Path

from agag.zulip import ZulipClient, ZulipError

FREEFORGE_CHANNEL = os.environ.get("ZULIP_FREEFORGE_CHANNEL") or "FreeForge"

# Autolab project names; the project channel is `pj-<name>` (zulip_channel_topic2).
PROJECT_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{1,38}$")

_HTTP_ERROR = re.compile(r"HTTP \d")


class RetryingZulipClient(ZulipClient):
    """One retry on a socket-level failure; HTTP answers are never retried."""

    def call(self, method, path, params=None, timeout=30):
        try:
            return super().call(method, path, params, timeout)
        except ZulipError as error:
            if _HTTP_ERROR.search(str(error)):
                raise
            return super().call(method, path, params, timeout)


_client: RetryingZulipClient | None = None


def get_client() -> RetryingZulipClient:
    global _client
    if _client is None:
        path = Path(os.environ.get("ZULIP_ENV_PATH") or "/run/secrets/zulip.env")
        _client = RetryingZulipClient.from_env(path)
    return _client


def stamped_topic_name(prefix: str, now: datetime | None = None, token: str | None = None) -> str:
    now = now or datetime.now()
    token = token or secrets.token_hex(3)
    return f"{prefix}-{now:%Y%m%d-%H%M%S}-{token}"


def project_channel_name(project: str) -> str:
    return f"pj-{project}"


def active_user_ids(client) -> list[int]:
    """Every active realm user — `users()` returns deactivated members too.

    A project channel subscribes all agents and the Developer (the
    braindump's participation rule), and "everyone" is the maintenance-free
    way to say that in a single-team realm.
    """
    return [
        int(member["user_id"])
        for member in client.users()
        if member.get("is_active") is not False
    ]


def open_forge_request(client, desire: str) -> dict:
    """One message opening a fresh `create-*` topic in #FreeForge.

    The topic list is its own index — no announcement message needed.
    Returns what a caller needs to watch and to resolve.
    """
    topic = stamped_topic_name("create")
    message_id = client.send_to_channel(FREEFORGE_CHANNEL, topic, desire)
    return {"channel": FREEFORGE_CHANNEL, "topic": topic, "message_id": message_id}


def open_mission_topic(client, project: str, briefing: str) -> dict:
    """One disposable `mission-*` topic in the standing `#pj-<name>` channel."""
    topic = stamped_topic_name("mission")
    channel = project_channel_name(project)
    message_id = client.send_to_channel(channel, topic, briefing)
    return {"channel": channel, "topic": topic, "message_id": message_id}


# --- route handlers (POST only; the server owns the 405) ---------------------

def _is_message_id(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def handle_freeforge(path: str, payload, client=None) -> tuple[int, dict]:
    """POST /api/freeforge/requests|resolve. The FreeForge workflow
    (zulip_channel_topic): the assistant's own Zulip account posts each desire
    as a fresh create-* topic; agforge's listener answers in the topic. Unlike
    /api/forge/requests, the conversation is public — the Developer watches
    and searches it in Zulip."""
    try:
        if path == "/api/freeforge/requests":
            desire = payload.get("desire") if isinstance(payload, dict) else None
            if not isinstance(desire, str) or not desire.strip():
                return 400, {"error": "bad_request", "detail": 'Body must be {"desire": "..."}.'}
            opened = open_forge_request(client or get_client(), desire.strip())
            return 201, {"kind": "freeforge.request.v1", **opened}
        if path == "/api/freeforge/resolve":
            message_id, topic = _resolve_args(payload)
            if message_id is None:
                return 400, {"error": "bad_request", "detail": 'Body must be {"message_id": N, "topic": "..."}.'}
            (client or get_client()).resolve_topic(message_id, topic)
            return 200, {"kind": "freeforge.resolve.v1", "message_id": message_id}
    except ZulipError as error:
        print(f"zulip send failed: {error}", file=sys.stderr, flush=True)
        return 502, {"error": "zulip_unavailable", "detail": str(error)}
    return 404, {"error": "not_found"}


def handle_missions(path: str, payload, client=None) -> tuple[int, dict]:
    """POST /api/autolab/missions|missions/resolve, mirroring the freeforge
    pair: one disposable mission-* topic per mission in the project channel.
    The autolab listener reacts to the topic; nothing here talks to a node."""
    try:
        if path == "/api/autolab/missions":
            project = payload.get("project") if isinstance(payload, dict) else None
            briefing = payload.get("briefing") if isinstance(payload, dict) else None
            if (not isinstance(project, str) or not PROJECT_NAME.match(project)
                    or not isinstance(briefing, str) or not briefing.strip()):
                return 400, {"error": "bad_request", "detail": 'Body must be {"project": "<name>", "briefing": "..."}.'}
            opened = open_mission_topic(client or get_client(), project, briefing.strip())
            return 201, {"kind": "autolab.mission.v1", **opened}
        if path == "/api/autolab/missions/resolve":
            message_id, topic = _resolve_args(payload)
            if message_id is None:
                return 400, {"error": "bad_request", "detail": 'Body must be {"message_id": N, "topic": "..."}.'}
            (client or get_client()).resolve_topic(message_id, topic)
            return 200, {"kind": "autolab.mission-resolve.v1", "message_id": message_id}
    except ZulipError as error:
        print(f"zulip send failed: {error}", file=sys.stderr, flush=True)
        return 502, {"error": "zulip_unavailable", "detail": str(error)}
    return 404, {"error": "not_found"}


def _resolve_args(payload) -> tuple[int | None, str]:
    message_id = payload.get("message_id") if isinstance(payload, dict) else None
    topic = payload.get("topic") if isinstance(payload, dict) else None
    if not _is_message_id(message_id) or not isinstance(topic, str) or topic == "":
        return None, ""
    return message_id, topic
