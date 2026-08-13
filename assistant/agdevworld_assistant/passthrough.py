"""The HTTP passthroughs: forge, autolab nodes and gateways, Plane.

Ports of `handleForge`, `handleAutolab`/`handleAutolabNodes` (server.mjs) and
the whole of `plane-passthrough.mjs`. These are same-origin passthroughs so
the browser (and the assistant's own `fetch` tool) reach the neighbouring
services without CORS and without holding any credential — the Plane API key
in particular never crosses this boundary.

Every handler takes an injectable `fetch` callable (the JS modules took a
`fetchImpl` for the same reason) and returns a `Reply`; the server owns the
socket. One `proxy_fetch()` serves all three routes: `urllib` raises
`HTTPError` on any status >= 400, but a passthrough must forward an upstream
404/422 verbatim, body included, so the error *is* the response here.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

JSON_TYPE = "application/json; charset=utf-8"

# forge answers in 20-105 s; the JS set no bound at all.
FORGE_TIMEOUT_SECONDS = 120
# 60 s, the same bound one `wait` gets: a node's own window answers in 3-28 s
# on its local model, so the 10 s this once held turned an open door into
# `node_offline` — a closed door reporting a wrong reason. Don't regress it.
NODE_TIMEOUT_SECONDS = 60
PROBE_TIMEOUT_SECONDS = 2
PLANE_TIMEOUT_SECONDS = 60


@dataclass
class Reply:
    status: int
    content_type: str
    body: bytes


def json_reply(status: int, obj: dict) -> Reply:
    return Reply(status, JSON_TYPE, json.dumps(obj, ensure_ascii=False).encode())


def proxy_fetch(url, *, method="GET", headers=None, body=None, timeout) -> Reply:
    """One upstream call whose >= 400 answers are responses, not exceptions.

    Network-level failures (`URLError`, timeouts — all `OSError`) still raise;
    each route maps those to its own offline envelope.
    """
    request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as upstream:
            return Reply(upstream.status, upstream.headers.get("content-type") or JSON_TYPE, upstream.read())
    except urllib.error.HTTPError as error:
        return Reply(error.code, error.headers.get("content-type") or JSON_TYPE, error.read())


# --- forge ------------------------------------------------------------------

# agforge request service (see agforge/README_DEV.md for the contract).
# Real endpoint values belong in env / compose, never committed defaults.
def forge_url(env=os.environ) -> str:
    return (env.get("AGFORGE_URL") or "http://host.docker.internal:8092").rstrip("/")


def handle_forge(method, url, content_type, body, env=os.environ, fetch=proxy_fetch) -> Reply:
    """/api/forge/<rest> -> AGFORGE_URL/api/<rest>, status and body verbatim."""
    base = forge_url(env)
    target = f"{base}/api{url[len('/api/forge'):]}"
    try:
        return fetch(
            target,
            method=method,
            headers={"Content-Type": content_type or "application/json"},
            body=None if method in ("GET", "HEAD") else (body or b""),
            timeout=FORGE_TIMEOUT_SECONDS,
        )
    except OSError:
        return json_reply(502, {
            "error": "forge_offline",
            "detail": f"The agforge service at {base} is unreachable.",
        })


# --- autolab ----------------------------------------------------------------

# AUTOLAB_NODES="<name>=<url>,..."; the committed default is the local node
# only, real cluster hostnames come from env like every other endpoint here.
# `or`, not a None-check: compose passes an empty string when the operator has
# not set one, and an empty string must mean "use the default", not "no nodes".
NODE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

# Safety device, not a wrongness guard: raw iteration evidence belongs to the
# agautolab node that produced it. Blocking the path here means no caller —
# page, assistant or curl — reaches around it. Nothing tells the assistant not
# to try; the 403 and its reason are returned as the answer.
EVIDENCE_PATH = re.compile(r"(^|/)evidence(/|$)")


def parse_nodes(spec: str) -> dict[str, str]:
    nodes: dict[str, str] = {}
    for entry in spec.split(","):
        trimmed = entry.strip()
        if not trimmed:
            continue
        name, eq, url = trimmed.partition("=")
        name, url = name.strip(), url.strip().rstrip("/")
        if not eq or not NODE_NAME.match(name) or not re.match(r"^https?://", url):
            print(f"ignoring malformed AUTOLAB_NODES entry: {trimmed}", flush=True)
            continue
        nodes[name] = url
    return nodes


def autolab_nodes(env=os.environ) -> dict[str, str]:
    return parse_nodes(env.get("AUTOLAB_NODES") or "agstudio=http://host.docker.internal:8791")


def _probe(name, url, fetch) -> dict:
    try:
        probe = fetch(f"{url}/healthz", timeout=PROBE_TIMEOUT_SECONDS)
        return {"name": name, "reachable": 200 <= probe.status < 300, "status": probe.status}
    except OSError as error:
        reason = getattr(error, "reason", error)
        return {"name": name, "reachable": False, "detail": type(reason).__name__}


def handle_autolab_nodes(nodes: dict[str, str], fetch=proxy_fetch) -> Reply:
    """The configured nodes and whether each answers right now.

    A node being down is normal (agautolab1 often is), so reachability is part
    of the answer rather than an error. Probes run concurrently to keep the
    frontend's polling snappy once there is more than one node.
    """
    with ThreadPoolExecutor(max_workers=max(len(nodes), 1)) as pool:
        probed = list(pool.map(lambda item: _probe(*item, fetch), nodes.items()))
    return json_reply(200, {"kind": "autolab.nodes.v1", "nodes": probed})


def handle_autolab(method, url, content_type, body, env=os.environ, fetch=proxy_fetch) -> Reply:
    """/api/autolab/<node>/<rest> -> <node url>/<rest>.

    Two safety devices live here, both about reach rather than correctness:
    the node list is finite (otherwise this is an open relay into the LAN),
    and raw evidence stays on the node that produced it. Both answer with
    their own reason, which the assistant reads like any other result. The
    node routes themselves are open (zero_auth episode) — what a POST may do
    is decided by the node, not by a gate here.
    """
    nodes = autolab_nodes(env)
    pathname, _, query = url[len("/api/autolab"):].partition("?")
    if pathname in ("/nodes", "/nodes/"):
        if method != "GET":
            return json_reply(405, {"error": "method_not_allowed"})
        return handle_autolab_nodes(nodes, fetch)
    _, node, *rest = pathname.split("/")
    path = "/" + "/".join(rest)
    base = nodes.get(node)
    if not base:
        return json_reply(404, {
            "error": "unknown_node",
            "detail": f'No autolab node named "{node}" is configured. '
                      f"Configured: {', '.join(nodes) or 'none'}.",
        })
    if EVIDENCE_PATH.search(path):
        return json_reply(403, {
            "error": "evidence_not_proxied",
            "detail": "Raw evidence stays on the node that produced it; the iteration summary crosses instead.",
        })
    target = f"{base}{path}" + (f"?{query}" if query else "")
    try:
        return fetch(
            target,
            method=method,
            headers={"Content-Type": content_type or "application/json"},
            body=None if method == "GET" else (body or b""),
            timeout=NODE_TIMEOUT_SECONDS,
        )
    except OSError:
        return json_reply(502, {
            "error": "node_offline",
            "detail": f'The autolab node "{node}" is unreachable.',
        })


# --- Plane ------------------------------------------------------------------

# Multi-project (zulip_channel_topic2): the project travels in the path —
# /api/plane/projects/<uuid>/issues|states/… — instead of being pinned in
# config. The bare /issues|/states form remains as the default-project view
# for the task UI and requires PLANE_PROJECT_ID to be configured.
PROJECT_SCOPED_PATH = re.compile(r"^/projects/([A-Za-z0-9-]+)(/(?:issues|states)(?:/[A-Za-z0-9_-]+)*/?)$")
DEFAULT_PROJECT_PATH = re.compile(r"^/(issues|states)(/[A-Za-z0-9_-]+)*/?$")


def read_plane_config(env=os.environ) -> dict:
    url = str(env.get("PLANE_URL") or "").strip().rstrip("/")
    api_key = str(env.get("PLANE_API_KEY") or "").strip()
    workspace = str(env.get("PLANE_WORKSPACE_SLUG") or "").strip()
    # Optional: only the bare /issues|/states default-project view needs it.
    project = str(env.get("PLANE_PROJECT_ID") or "").strip()
    missing = []
    if not url:
        missing.append("PLANE_URL")
    if not api_key:
        missing.append("PLANE_API_KEY")
    if not workspace:
        missing.append("PLANE_WORKSPACE_SLUG")
    if url and not re.match(r"^https?://", url):
        missing.append("valid PLANE_URL")
    return {"url": url, "api_key": api_key, "workspace": workspace, "project": project, "missing": missing}


def _project_base(config: dict, project: str) -> str:
    return (f"{config['url']}/api/v1/workspaces/{urllib.parse.quote(config['workspace'], safe='')}"
            f"/projects/{urllib.parse.quote(project, safe='')}")


def _state_id_for_name(config, project, name, fetch) -> dict:
    reply = fetch(
        f"{_project_base(config, project)}/states/",
        headers={"X-API-Key": config["api_key"]},
        timeout=PLANE_TIMEOUT_SECONDS,
    )
    if not 200 <= reply.status < 300:
        return {"reply": reply}
    try:
        payload = json.loads(reply.body)
    except ValueError:
        payload = None
    states = payload if isinstance(payload, list) else (payload or {}).get("results")
    if isinstance(states, list):
        for state in states:
            if str(state.get("name")).lower() == str(name).lower():
                return {"id": state["id"]}
    return {"missing": True}


def proxy_plane_request(method, url, content_type, body, config, fetch=proxy_fetch) -> Reply:
    """Same-origin, project-scoped Plane passthrough.

    The API key never crosses this boundary, and callers cannot widen the
    configured workspace by putting identifiers in a URL. Human-readable
    `state_name` values are resolved against the running instance so
    environment-specific UUIDs stay out of the guide and browser.
    """
    if config["missing"]:
        return json_reply(503, {
            "error": "plane_unconfigured",
            "detail": f"Missing Plane configuration: {', '.join(config['missing'])}.",
        })

    full_path, _, query = url[len("/api/plane"):].partition("?")
    full_path = full_path or "/"
    scoped = PROJECT_SCOPED_PATH.match(full_path)
    if scoped:
        project, path = scoped.group(1), scoped.group(2)
    elif DEFAULT_PROJECT_PATH.match(full_path):
        if not config["project"]:
            return json_reply(404, {
                "error": "plane_no_default_project",
                "detail": "No default Plane project is configured; use /api/plane/projects/<uuid>/… instead.",
            })
        project, path = config["project"], full_path
    else:
        return json_reply(404, {
            "error": "plane_path_not_proxied",
            "detail": "Only per-project issues and states (/api/plane/projects/<uuid>/…) are reachable through the Plane passthrough.",
        })
    if method not in ("GET", "POST", "PATCH"):
        return json_reply(405, {"error": "method_not_allowed"})

    if body and method in ("POST", "PATCH"):
        try:
            payload = json.loads(body)
        except ValueError:
            payload = None
        if isinstance(payload, dict) and "state_name" in payload:
            name = payload["state_name"]
            resolved = _state_id_for_name(config, project, name, fetch)
            if "reply" in resolved:
                return resolved["reply"]
            if resolved.get("missing"):
                return json_reply(400, {
                    "error": "unknown_plane_state",
                    "detail": f'No state named "{name}" exists in the configured Plane project.',
                })
            payload["state"] = resolved["id"]
            del payload["state_name"]
            body = json.dumps(payload).encode()

    # Plane redirects paths without the trailing slash; append it instead.
    upstream_path = path if path.endswith("/") else f"{path}/"
    target = f"{_project_base(config, project)}{upstream_path}" + (f"?{query}" if query else "")
    return fetch(
        target,
        method=method,
        headers={"X-API-Key": config["api_key"], "Content-Type": content_type or "application/json"},
        body=None if method == "GET" else body,
        timeout=PLANE_TIMEOUT_SECONDS,
    )


def handle_plane(method, url, content_type, body, env=os.environ, fetch=proxy_fetch) -> Reply:
    """The route wrapper: config from env, network failure -> plane_offline."""
    try:
        return proxy_plane_request(method, url, content_type, body, read_plane_config(env), fetch)
    except OSError:
        return json_reply(502, {
            "error": "plane_offline",
            "detail": "The configured Plane service is unreachable.",
        })
