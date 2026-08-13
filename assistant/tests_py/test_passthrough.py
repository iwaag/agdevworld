import json

from agdevworld_assistant.passthrough import (
    Reply,
    handle_autolab,
    handle_forge,
    handle_plane,
    parse_nodes,
    proxy_plane_request,
    read_plane_config,
)

PLANE_ENV = {
    "PLANE_URL": "http://plane.example/",
    "PLANE_API_KEY": "server-secret",
    "PLANE_WORKSPACE_SLUG": "agautolab",
    "PLANE_PROJECT_ID": "project-id",
}
PLANE_CONFIG = read_plane_config(PLANE_ENV)


def json_reply(status, obj):
    return Reply(status, "application/json", json.dumps(obj).encode())


def recording(reply_for):
    calls = []

    def fetch(url, *, method="GET", headers=None, body=None, timeout):
        calls.append({"url": url, "method": method, "headers": headers or {}, "body": body, "timeout": timeout})
        return reply_for(url)

    return calls, fetch


def offline_fetch(url, **_kwargs):
    raise OSError("connection refused")


def body_json(reply):
    return json.loads(reply.body)


# --- forge -------------------------------------------------------------------

def test_forge_forwards_path_query_body_and_upstream_status():
    calls, fetch = recording(lambda url: Reply(422, "application/json", b'{"error":"nope"}'))
    reply = handle_forge(
        "POST", "/api/forge/requests?x=1", "text/plain", b'{"desire":"a"}',
        env={"AGFORGE_URL": "http://forge.example/"}, fetch=fetch,
    )
    assert calls[0]["url"] == "http://forge.example/api/requests?x=1"
    assert calls[0]["headers"]["Content-Type"] == "text/plain"
    assert calls[0]["body"] == b'{"desire":"a"}'
    assert calls[0]["timeout"] == 120
    assert (reply.status, reply.body) == (422, b'{"error":"nope"}')  # verbatim, not remapped


def test_forge_get_sends_no_body_and_defaults_the_content_type():
    calls, fetch = recording(lambda url: Reply(200, "application/json", b"{}"))
    handle_forge("GET", "/api/forge/requests/abc", None, None, env={}, fetch=fetch)
    assert calls[0]["url"] == "http://host.docker.internal:8092/api/requests/abc"
    assert calls[0]["body"] is None
    assert calls[0]["headers"]["Content-Type"] == "application/json"


def test_forge_unreachable_is_forge_offline():
    reply = handle_forge("GET", "/api/forge/requests", None, None, env={}, fetch=offline_fetch)
    assert reply.status == 502
    assert body_json(reply)["error"] == "forge_offline"


# --- autolab -----------------------------------------------------------------

def test_parse_nodes_skips_malformed_entries():
    nodes = parse_nodes("agstudio=http://a:1/, bad, name=ftp://x, ok.node-2=https://b")
    assert nodes == {"agstudio": "http://a:1", "ok.node-2": "https://b"}


def test_nodes_probe_reports_up_down_and_unreachable():
    def reply_for(url):
        if url.startswith("http://up"):
            return Reply(200, "application/json", b'{"ok":true}')
        return Reply(500, "text/plain", b"boom")

    calls, fetch = recording(reply_for)

    def fetch_or_refuse(url, **kwargs):
        if url.startswith("http://dead"):
            raise ConnectionRefusedError("refused")
        return fetch(url, **kwargs)

    reply = handle_autolab(
        "GET", "/api/autolab/nodes", None, None,
        env={"AUTOLAB_NODES": "up=http://up:1,sick=http://sick:1,dead=http://dead:1"},
        fetch=fetch_or_refuse,
    )
    assert reply.status == 200
    payload = body_json(reply)
    assert payload["kind"] == "autolab.nodes.v1"
    by_name = {node["name"]: node for node in payload["nodes"]}
    assert by_name["up"] == {"name": "up", "reachable": True, "status": 200}
    assert by_name["sick"] == {"name": "sick", "reachable": False, "status": 500}
    assert by_name["dead"] == {"name": "dead", "reachable": False, "detail": "ConnectionRefusedError"}
    assert all(call["timeout"] == 2 for call in calls)


def test_nodes_list_is_get_only():
    reply = handle_autolab("POST", "/api/autolab/nodes", None, b"{}", env={}, fetch=offline_fetch)
    assert (reply.status, body_json(reply)["error"]) == (405, "method_not_allowed")


def test_autolab_unknown_node_lists_the_configured_names():
    reply = handle_autolab("GET", "/api/autolab/ghost/status", None, None, env={}, fetch=offline_fetch)
    assert reply.status == 404
    detail = body_json(reply)
    assert detail["error"] == "unknown_node"
    assert 'named "ghost"' in detail["detail"]
    assert "agstudio" in detail["detail"]  # the empty-env default node


def test_autolab_empty_env_means_the_default_node_not_no_nodes():
    calls, fetch = recording(lambda url: Reply(200, "application/json", b"{}"))
    handle_autolab("GET", "/api/autolab/agstudio/status", None, None, env={"AUTOLAB_NODES": ""}, fetch=fetch)
    assert calls[0]["url"] == "http://host.docker.internal:8791/status"


def test_autolab_evidence_paths_answer_403_without_touching_the_node():
    for path in ("/api/autolab/agstudio/evidence", "/api/autolab/agstudio/jobs/1/evidence/raw.log"):
        reply = handle_autolab("GET", path, None, None, env={}, fetch=offline_fetch)
        assert (reply.status, body_json(reply)["error"]) == (403, "evidence_not_proxied")


def test_autolab_forwards_query_and_upstream_error_bodies_verbatim():
    calls, fetch = recording(lambda url: Reply(409, "application/json", b'{"error":"busy"}'))
    reply = handle_autolab(
        "POST", "/api/autolab/agstudio/window?wait=1", "application/json", b'{"text":"hi"}',
        env={}, fetch=fetch,
    )
    assert calls[0]["url"] == "http://host.docker.internal:8791/window?wait=1"
    assert calls[0]["timeout"] == 60
    assert (reply.status, reply.body) == (409, b'{"error":"busy"}')


def test_autolab_unreachable_node_is_node_offline():
    reply = handle_autolab("GET", "/api/autolab/agstudio/status", None, None, env={}, fetch=offline_fetch)
    assert reply.status == 502
    assert body_json(reply)["error"] == "node_offline"


# --- Plane -------------------------------------------------------------------

def test_plane_config_reports_missing_server_side_values_without_the_key():
    missing = read_plane_config({"PLANE_URL": "http://plane.example"})
    # PLANE_PROJECT_ID is optional (multi-project): only the bare
    # default-project paths need it.
    assert missing["missing"] == ["PLANE_API_KEY", "PLANE_WORKSPACE_SLUG"]
    assert "server-secret" not in json.dumps(missing)


def test_plane_unconfigured_answers_503():
    reply = proxy_plane_request("GET", "/api/plane/issues", None, None, read_plane_config({}), offline_fetch)
    assert (reply.status, body_json(reply)["error"]) == (503, "plane_unconfigured")


def test_plane_project_scoped_paths_carry_their_own_project_id():
    calls, fetch = recording(lambda url: Reply(200, "application/json", b'{"results":[]}'))
    reply = proxy_plane_request("GET", "/api/plane/projects/other-uuid/issues?per_page=5", None, None, PLANE_CONFIG, fetch)
    assert reply.status == 200
    assert calls[0]["url"] == "http://plane.example/api/v1/workspaces/agautolab/projects/other-uuid/issues/?per_page=5"


def test_plane_bare_paths_without_a_default_project_answer_404():
    config = read_plane_config({"PLANE_URL": "http://plane.example", "PLANE_API_KEY": "k", "PLANE_WORKSPACE_SLUG": "agautolab"})
    reply = proxy_plane_request("GET", "/api/plane/issues", None, None, config, offline_fetch)
    assert (reply.status, body_json(reply)["error"]) == (404, "plane_no_default_project")


def test_plane_fixes_the_project_scope_and_injects_the_api_key():
    calls, fetch = recording(lambda url: Reply(200, "application/json", b'{"results":[]}'))
    reply = proxy_plane_request("GET", "/api/plane/issues?per_page=50", None, None, PLANE_CONFIG, fetch)
    assert reply.status == 200
    assert calls[0]["url"] == "http://plane.example/api/v1/workspaces/agautolab/projects/project-id/issues/?per_page=50"
    assert calls[0]["headers"]["X-API-Key"] == "server-secret"
    assert reply.body == b'{"results":[]}'


def test_plane_refuses_paths_outside_issues_and_states():
    reply = proxy_plane_request("GET", "/api/plane/workspaces", None, None, PLANE_CONFIG, offline_fetch)
    assert (reply.status, body_json(reply)["error"]) == (404, "plane_path_not_proxied")


def test_plane_refuses_delete():
    reply = proxy_plane_request("DELETE", "/api/plane/issues/issue-id", None, None, PLANE_CONFIG, offline_fetch)
    assert (reply.status, body_json(reply)["error"]) == (405, "method_not_allowed")


def test_plane_resolves_state_name_through_the_live_project_states():
    def reply_for(url):
        if url.endswith("/states/"):
            return json_reply(200, {"results": [{"id": "ready-id", "name": "Ready"}]})
        return json_reply(201, {"id": "issue-id"})

    calls, fetch = recording(reply_for)
    reply = proxy_plane_request(
        "POST", "/api/plane/issues", "application/json",
        json.dumps({"name": "Readable UI", "state_name": "ready"}).encode(),
        PLANE_CONFIG, fetch,
    )
    assert reply.status == 201
    assert len(calls) == 2
    assert json.loads(calls[1]["body"]) == {"name": "Readable UI", "state": "ready-id"}
    assert calls[1]["headers"]["X-API-Key"] == "server-secret"


def test_plane_answers_an_explicit_error_for_an_unknown_state_name():
    calls, fetch = recording(lambda url: json_reply(200, {"results": [{"id": "ready-id", "name": "Ready"}]}))
    reply = proxy_plane_request(
        "PATCH", "/api/plane/issues/issue-id", "application/json",
        json.dumps({"state_name": "Imaginary"}).encode(),
        PLANE_CONFIG, fetch,
    )
    assert (reply.status, body_json(reply)["error"]) == (400, "unknown_plane_state")
    assert b"server-secret" not in reply.body


def test_plane_forwards_a_failed_state_lookup_verbatim():
    calls, fetch = recording(lambda url: Reply(401, "application/json", b'{"detail":"bad key"}'))
    reply = proxy_plane_request(
        "POST", "/api/plane/issues", "application/json",
        json.dumps({"state_name": "Ready"}).encode(),
        PLANE_CONFIG, fetch,
    )
    assert (reply.status, reply.body) == (401, b'{"detail":"bad key"}')
    assert len(calls) == 1  # the issue POST never happened


def test_plane_unreachable_is_plane_offline():
    reply = handle_plane("GET", "/api/plane/issues", None, None, env=PLANE_ENV, fetch=offline_fetch)
    assert (reply.status, body_json(reply)["error"]) == (502, "plane_offline")
