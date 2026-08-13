"""Project start for autolab projects (port of autolab-projects.mjs).

One call provisions the three standing pieces a project needs before any
mission can run — and nothing else. No Plane issue, no task planning, no
mission: prep and dev start stay separable in the evidence (the S5 lesson).

- Gitea: the `<name>` + `<name>-direction` repo pair under the autodev org,
  the direction repo seeded with GUIDE.md / concept.md / .gitignore
  (agautolab/AGENT_GUIDE.md "Projects").
- Plane: a fresh project in the configured workspace; its UUID and state ids
  are returned so mission briefings can carry them (multi-project: the
  project UUID travels in the mission text, never in node config).
- Zulip: the standing `#pj-<name>` channel, subscribing every active realm
  user (all agents + the Developer).

Provisioning order is the contract: any step's failure aborts the rest, and
`ProjectStartError.step` names how far it got, so a human (or a retry) can
pick up from the evidence.
"""

from __future__ import annotations

import json
import os
import re
from base64 import b64encode
from pathlib import Path

from .passthrough import proxy_fetch
from .workflows import active_user_ids, project_channel_name

GITEA_TIMEOUT_SECONDS = 30
PLANE_TIMEOUT_SECONDS = 60


def read_gitea_config(env=os.environ) -> dict:
    url = str(env.get("GITEA_URL") or "").strip().rstrip("/")
    token_path = str(env.get("GITEA_TOKEN_PATH") or "/run/secrets/gitea.token").strip()
    org = str(env.get("GITEA_ORG") or "autodev").strip()
    missing = []
    if not url:
        missing.append("GITEA_URL")
    if url and not re.match(r"^https?://", url):
        missing.append("valid GITEA_URL")
    return {"url": url, "token_path": token_path, "org": org, "missing": missing}


def read_plane_workspace_config(env=os.environ) -> dict:
    url = str(env.get("PLANE_URL") or "").strip().rstrip("/")
    api_key = str(env.get("PLANE_API_KEY") or "").strip()
    workspace = str(env.get("PLANE_WORKSPACE_SLUG") or "").strip()
    missing = []
    if not url:
        missing.append("PLANE_URL")
    if not api_key:
        missing.append("PLANE_API_KEY")
    if not workspace:
        missing.append("PLANE_WORKSPACE_SLUG")
    return {"url": url, "api_key": api_key, "workspace": workspace, "missing": missing}


def plane_identifier(project: str) -> str:
    """"whack-a-mole-2" -> "WAM2": initials of the word parts plus any numeric
    parts, which keeps identifiers short, readable, and distinct across the
    `<name>-N` families Phase B provisions."""
    parts = [part for part in re.split(r"[^a-z0-9]+", project) if part]
    identifier = "".join(part if part.isdigit() else part[0] for part in parts)
    return identifier.upper()[:12]


class ProjectStartError(Exception):
    def __init__(self, step: str, message: str):
        super().__init__(f"{step}: {message}")
        self.step = step


def _gitea_call(config, token, method, path, body, fetch):
    # A network-level failure becomes its step's own error envelope (the JS
    # let it escape to a bare 500; an explicit step beats an anonymous one).
    try:
        reply = fetch(
            f"{config['url']}/api/v1{path}",
            method=method,
            headers={"Authorization": f"token {token}", "Content-Type": "application/json"},
            body=None if body is None else json.dumps(body).encode(),
            timeout=GITEA_TIMEOUT_SECONDS,
        )
    except OSError as error:
        raise ProjectStartError("gitea", f"{method} {path} -> {error}") from error
    text = reply.body.decode("utf-8", "replace")
    try:
        parsed = json.loads(text)
    except ValueError:
        parsed = None
    if not 200 <= reply.status < 300:
        detail = (parsed or {}).get("message") if isinstance(parsed, dict) else None
        raise ProjectStartError("gitea", f"{method} {path} -> HTTP {reply.status}: {detail or text[:200]}")
    return parsed


def _direction_seed_files(project: str, concept: str) -> dict[str, str]:
    return {
        "GUIDE.md": f"# {project}-direction\n\nProject: {project}\nRole: director\n",
        "concept.md": f"# {project} — concept\n\n{concept.strip()}\n",
        ".gitignore": ".local/\n",
    }


def create_gitea_repo_pair(config, project, concept, fetch=proxy_fetch) -> dict:
    # Token read from file at request time, never held in the environment.
    try:
        token = Path(config["token_path"]).read_text(encoding="utf-8").strip()
    except OSError as error:
        raise ProjectStartError("gitea", f"token unreadable: {error}") from error
    repos = [project, f"{project}-direction"]
    for name in repos:
        _gitea_call(config, token, "POST", f"/orgs/{config['org']}/repos", {
            "name": name,
            "private": False,
            "default_branch": "main",
        }, fetch)
    seeds = _direction_seed_files(project, concept)
    for path, body in seeds.items():
        _gitea_call(
            config, token, "POST",
            f"/repos/{config['org']}/{project}-direction/contents/{urlquote(path)}",
            {"content": b64encode(body.encode()).decode(), "message": f"Seed {path}"},
            fetch,
        )
    return {"repos": [f"{config['org']}/{name}" for name in repos], "seeded": list(seeds)}


def urlquote(value: str) -> str:
    import urllib.parse
    return urllib.parse.quote(value, safe="")


def create_plane_project(config, project, concept, fetch=proxy_fetch) -> dict:
    base = f"{config['url']}/api/v1/workspaces/{urlquote(config['workspace'])}/projects"
    headers = {"X-API-Key": config["api_key"], "Content-Type": "application/json"}
    try:
        reply = fetch(f"{base}/", method="POST", headers=headers, body=json.dumps({
            "name": project,
            "identifier": plane_identifier(project),
            "description": concept.strip(),
        }).encode(), timeout=PLANE_TIMEOUT_SECONDS)
    except OSError as error:
        raise ProjectStartError("plane", f"project create -> {error}") from error
    try:
        payload = json.loads(reply.body)
    except ValueError:
        payload = None
    if not 200 <= reply.status < 300:
        raise ProjectStartError(
            "plane", f"project create -> HTTP {reply.status}: {json.dumps(payload)[:200]}"
        )
    try:
        states_reply = fetch(f"{base}/{payload['id']}/states/", headers=headers, timeout=PLANE_TIMEOUT_SECONDS)
    except OSError as error:
        raise ProjectStartError("plane", f"state list -> {error}") from error
    try:
        states_payload = json.loads(states_reply.body)
    except ValueError:
        states_payload = None
    rows = states_payload if isinstance(states_payload, list) else (states_payload or {}).get("results")
    if not 200 <= states_reply.status < 300 or not isinstance(rows, list):
        raise ProjectStartError("plane", f"state list -> HTTP {states_reply.status}")
    return {
        "id": payload["id"],
        "identifier": payload.get("identifier"),
        "states": {state["name"]: state["id"] for state in rows},
    }


def create_project_channel(client, project) -> dict:
    channel = project_channel_name(project)
    principals = active_user_ids(client)
    client.create_channel(
        channel,
        f"Project channel for autolab project {project} (standing channel, disposable mission-* topics)",
        principals,
    )
    return {"channel": channel, "principals": principals}


def start_project(project, concept, *, gitea, plane, client, fetch=proxy_fetch) -> dict:
    """The whole project start, in provisioning order."""
    created = {}
    created["gitea"] = create_gitea_repo_pair(gitea, project, concept, fetch)
    created["plane"] = create_plane_project(plane, project, concept, fetch)
    created["zulip"] = create_project_channel(client, project)
    return created
