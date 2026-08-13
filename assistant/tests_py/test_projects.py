import json
from base64 import b64decode

import pytest
from agag.zulip import ZulipError

from agdevworld_assistant.passthrough import Reply
from agdevworld_assistant.projects import (
    ProjectStartError,
    create_gitea_repo_pair,
    create_plane_project,
    create_project_channel,
    plane_identifier,
    plane_name,
    read_gitea_config,
    read_plane_workspace_config,
    start_project,
)
from agdevworld_assistant.workflows import PROJECT_NAME, handle_project_start


def json_reply(status, body):
    return Reply(status, "application/json", json.dumps(body).encode())


@pytest.fixture
def gitea_config(tmp_path):
    token = tmp_path / "token"
    token.write_text("sekrit\n")
    return {"url": "http://gitea.test", "token_path": str(token), "org": "autodev", "missing": []}


PLANE_CONFIG = {"url": "http://plane.test", "api_key": "k", "workspace": "ws", "missing": []}


class FakeZulip:
    def __init__(self):
        self.created = []

    def users(self):
        return [{"user_id": 8, "is_active": True}, {"user_id": 13}, {"user_id": 5, "is_active": False}]

    def create_channel(self, name, description, principals):
        self.created.append((name, principals))


def test_project_names_are_lowercase_hyphen_only():
    assert PROJECT_NAME.match("whack-a-mole-2")
    for bad in ("Whack", "a", "-x"):
        assert not PROJECT_NAME.match(bad)


def test_plane_identifiers_are_initials_plus_numeric_parts():
    assert plane_identifier("whack-a-mole") == "WAM"
    assert plane_identifier("whack-a-mole-2") == "WAM2"


def test_single_word_names_keep_their_letters_so_they_do_not_all_collide():
    assert plane_identifier("quiz") == "QUIZ"
    assert plane_identifier("p3smoke1") != plane_identifier("p3smoke2")
    assert plane_identifier("a" * 20) == "A" * 12


def test_plane_names_drop_the_hyphens_plane_refuses():
    assert plane_name("whack-a-mole-2") == "whack a mole 2"
    assert plane_name("quiz") == "quiz"


def test_config_readers_report_what_is_missing():
    assert read_gitea_config({})["missing"] == ["GITEA_URL"]
    assert read_gitea_config({"GITEA_URL": "http://g"})["missing"] == []
    assert read_gitea_config({})["org"] == "autodev"
    assert read_plane_workspace_config({"PLANE_URL": "http://p", "PLANE_API_KEY": "k"})["missing"] == ["PLANE_WORKSPACE_SLUG"]


def test_create_gitea_repo_pair_creates_both_repos_and_seeds_the_direction_repo(gitea_config):
    calls = []

    def fetch(url, *, method="GET", headers=None, body=None, timeout):
        calls.append((url, method, body, headers))
        return json_reply(201, {"ok": True})

    result = create_gitea_repo_pair(gitea_config, "demo", "a demo game", fetch)
    assert result["repos"] == ["autodev/demo", "autodev/demo-direction"]
    assert result["seeded"] == ["GUIDE.md", "concept.md", ".gitignore"]
    assert len(calls) == 5
    assert calls[0][0].endswith("/api/v1/orgs/autodev/repos")
    assert calls[0][1] == "POST"
    assert calls[0][3]["Authorization"] == "token sekrit"
    assert "/repos/autodev/demo-direction/contents/GUIDE.md" in calls[2][0]
    seeded = json.loads(calls[3][2])
    assert "a demo game" in b64decode(seeded["content"]).decode()


def test_create_gitea_repo_pair_surfaces_the_failing_step(gitea_config):
    def fetch(url, **_kwargs):
        return json_reply(409, {"message": "repo exists"})

    with pytest.raises(ProjectStartError, match="409") as caught:
        create_gitea_repo_pair(gitea_config, "demo", "c", fetch)
    assert caught.value.step == "gitea"


def test_create_gitea_repo_pair_reports_an_unreadable_token(gitea_config):
    gitea_config["token_path"] = "/nonexistent/token"
    with pytest.raises(ProjectStartError, match="token unreadable") as caught:
        create_gitea_repo_pair(gitea_config, "demo", "c", lambda *a, **k: json_reply(201, {}))
    assert caught.value.step == "gitea"


def test_create_plane_project_returns_the_uuid_and_state_ids():
    sent = []

    def fetch(url, *, method="GET", headers=None, body=None, timeout):
        if method == "POST":
            sent.append(json.loads(body))
            return json_reply(201, {"id": "uuid-1", "identifier": "DG"})
        return json_reply(200, [{"name": "Todo", "id": "s-todo"}, {"name": "Done", "id": "s-done"}])

    result = create_plane_project(PLANE_CONFIG, "demo-game", "concept", fetch)
    assert result == {"id": "uuid-1", "identifier": "DG", "states": {"Todo": "s-todo", "Done": "s-done"}}
    assert sent[0]["name"] == "demo game"
    assert sent[0]["identifier"] == "DG"


def test_a_failed_create_names_the_name_and_the_identifier_it_sent():
    def fetch(url, **_kwargs):
        return json_reply(409, {"name": "The project name is already taken"})

    with pytest.raises(ProjectStartError, match="identifier='P3SMOKE2'"):
        create_plane_project(PLANE_CONFIG, "p3smoke2", "c", fetch)


def test_create_plane_project_surfaces_a_failed_create():
    def fetch(url, **_kwargs):
        return json_reply(422, {"identifier": "taken"})

    with pytest.raises(ProjectStartError, match="422") as caught:
        create_plane_project(PLANE_CONFIG, "demo", "c", fetch)
    assert caught.value.step == "plane"


def test_create_project_channel_subscribes_every_active_user():
    client = FakeZulip()
    result = create_project_channel(client, "demo")
    assert client.created == [("pj-demo", [8, 13])]
    assert result == {"channel": "pj-demo", "principals": [8, 13]}


def test_start_project_provisions_gitea_plane_and_zulip_in_order(gitea_config):
    order = []

    def fetch(url, *, method="GET", headers=None, body=None, timeout):
        if url.startswith("http://gitea.test"):
            order.append("gitea")
            return json_reply(201, {})
        order.append("plane")
        if method == "POST":
            return json_reply(201, {"id": "u", "identifier": "D"})
        return json_reply(200, [])

    class OrderedZulip(FakeZulip):
        def create_channel(self, name, description, principals):
            order.append("zulip")

    created = start_project("demo", "c", gitea=gitea_config, plane=PLANE_CONFIG,
                            client=OrderedZulip(), fetch=fetch)
    assert order.count("gitea") == 5
    assert order[-3:] == ["plane", "plane", "zulip"]
    assert created["zulip"]["channel"] == "pj-demo"


def test_start_project_aborts_after_the_failing_step(gitea_config):
    calls = []

    def fetch(url, **_kwargs):
        calls.append(url)
        if url.startswith("http://gitea.test"):
            return json_reply(201, {})
        return json_reply(500, {"detail": "plane down"})

    client = FakeZulip()
    with pytest.raises(ProjectStartError) as caught:
        start_project("demo", "c", gitea=gitea_config, plane=PLANE_CONFIG, client=client, fetch=fetch)
    assert caught.value.step == "plane"
    assert client.created == []  # zulip never reached


# --- the route ---------------------------------------------------------------

def route_env(**overrides):
    env = {"GITEA_URL": "http://gitea.test", "PLANE_URL": "http://plane.test",
           "PLANE_API_KEY": "k", "PLANE_WORKSPACE_SLUG": "ws"}
    env.update(overrides)
    return {k: v for k, v in env.items() if v is not None}


@pytest.mark.parametrize("payload", [
    None, {}, {"project": "Bad", "concept": "c"}, {"project": "ok-name"},
    {"project": "ok-name", "concept": " "},
])
def test_project_start_validates_project_and_concept(payload):
    code, body = handle_project_start(payload, client=FakeZulip(), env=route_env())
    assert (code, body["error"]) == (400, "bad_request")


def test_project_start_preflights_the_configuration():
    code, body = handle_project_start(
        {"project": "ok-name", "concept": "c"}, client=FakeZulip(),
        env=route_env(GITEA_URL=None, PLANE_WORKSPACE_SLUG=None),
    )
    assert (code, body["error"]) == (503, "project_start_unconfigured")
    assert "GITEA_URL" in body["detail"] and "PLANE_WORKSPACE_SLUG" in body["detail"]


def test_project_start_answers_201_with_all_three_pieces(gitea_config, tmp_path):
    def fetch(url, *, method="GET", headers=None, body=None, timeout):
        if "gitea.test" in url:
            return json_reply(201, {})
        if method == "POST":
            return json_reply(201, {"id": "uuid-1", "identifier": "ON"})
        return json_reply(200, [{"name": "Todo", "id": "s1"}])

    code, body = handle_project_start(
        {"project": "ok-name", "concept": "c"}, client=FakeZulip(), fetch=fetch,
        env=route_env(GITEA_TOKEN_PATH=gitea_config["token_path"]),
    )
    assert code == 201
    assert body["kind"] == "autolab.project.v1"
    assert body["project"] == "ok-name"
    assert body["gitea"]["repos"] == ["autodev/ok-name", "autodev/ok-name-direction"]
    assert body["plane"]["states"] == {"Todo": "s1"}
    assert body["zulip"]["channel"] == "pj-ok-name"


def test_project_start_maps_a_step_failure_to_502_with_the_step(gitea_config):
    def fetch(url, **_kwargs):
        return json_reply(403, {"message": "forbidden"})

    code, body = handle_project_start(
        {"project": "ok-name", "concept": "c"}, client=FakeZulip(), fetch=fetch,
        env=route_env(GITEA_TOKEN_PATH=gitea_config["token_path"]),
    )
    assert (code, body["error"], body["step"]) == (502, "project_start_failed", "gitea")


def test_project_start_maps_a_zulip_failure_to_502(gitea_config):
    def fetch(url, *, method="GET", headers=None, body=None, timeout):
        if "gitea.test" in url:
            return json_reply(201, {})
        if method == "POST":
            return json_reply(201, {"id": "u", "identifier": "D"})
        return json_reply(200, [])

    class BrokenZulip(FakeZulip):
        def users(self):
            raise ZulipError("GET users -> HTTP 500: down")

    code, body = handle_project_start(
        {"project": "ok-name", "concept": "c"}, client=BrokenZulip(), fetch=fetch,
        env=route_env(GITEA_TOKEN_PATH=gitea_config["token_path"]),
    )
    assert (code, body["error"]) == (502, "zulip_unavailable")
