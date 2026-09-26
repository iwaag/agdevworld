"""Context repositories through the relay (`give_context_easier` p1).

A git host of plain bare repositories stands in for Gitea's git side and a
fake API for its REST side, so every write here goes through real git:
the catalog read, creation that finishes on retry, registration, catalog
edits with archive/reactivate, publication on a base revision and the
conflict when the branch has moved, file bytes at a pinned commit, and the
HTTP routes over all of it.
"""

from __future__ import annotations

import base64
import json
import subprocess
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from agag import refs

from agentroom.contexts import Contexts, ContextsError
from agentroom.server import build_server

from conftest import empty_room

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def git(*args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def seed(bare: Path, files: dict[str, str | bytes], message: str = "seed") -> str:
    """Push one commit of `files` onto `bare`'s main, like a human would."""
    work = bare.parent / f".work-{bare.name}"
    if not work.exists():
        git("clone", "-q", str(bare), str(work), cwd=bare.parent)
        git("config", "user.email", "dev@example.invalid", cwd=work)
        git("config", "user.name", "Developer", cwd=work)
    else:
        git("pull", "-q", "origin", "main", cwd=work)
    for name, data in files.items():
        target = work / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data) if isinstance(data, bytes) else target.write_text(data, encoding="utf-8")
    git("add", "-A", cwd=work)
    git("commit", "-q", "-m", message, cwd=work)
    git("push", "-q", "origin", "HEAD:main", cwd=work)
    return git("rev-parse", "HEAD", cwd=work)


class FakeGitea:
    """`/user`, `/repos/<o>/<r>` and `POST /user/repos` over bare repos on disk."""

    def __init__(self, root: Path, owner: str = "developer") -> None:
        self.root = root
        self.owner = owner
        self.created: list[str] = []
        self.descriptions: dict[str, str] = {}
        self.fail_create = False

    def path(self, owner, name) -> Path:
        return self.root / owner / name

    def user(self):
        return {"login": self.owner, "full_name": "Developer", "email": "developer@example.invalid"}

    def repo(self, owner, name):
        return {"name": name} if (self.path(owner, name) / "HEAD").exists() else None

    def create_repo(self, name, description, branch):
        if self.fail_create:
            raise ContextsError("Gitea is down", 502)
        target = self.path(self.owner, name)
        target.mkdir(parents=True)
        git("init", "-q", "--bare", "-b", branch, str(target), cwd=self.root)
        self.created.append(name)
        self.descriptions[name] = description
        return {"name": name}

    def set_description(self, owner, name, description):
        self.descriptions[name] = description


CATALOG = f'''schema = "{refs.CATALOG_SCHEMA}"

[[source]]
id = "protoprey-refs"
name = "ProtoPrey references"
description = "Stories and images for ProtoPrey"
repository = "developer/protoprey-refs"
branch = "main"
status = "active"
'''


@pytest.fixture
def world(tmp_path, monkeypatch):
    host = tmp_path / "githost"
    (host / "developer").mkdir(parents=True)
    for name in ("context-catalog", "protoprey-refs"):
        git("init", "-q", "--bare", "-b", "main", str(host / "developer" / name), cwd=tmp_path)
    seed(host / "developer" / "context-catalog", {"catalog.toml": CATALOG}, "catalog")
    first = seed(host / "developer" / "protoprey-refs", {"README.md": "# ProtoPrey\n\nMeadow at dusk.\n",
                                                          "images/meadow.png": PNG}, "first")
    hostcfg = tmp_path / "hostcfg.toml"
    hostcfg.write_text(f'[catalog]\nurl = "{host / "developer" / "context-catalog"}"\n', encoding="utf-8")
    monkeypatch.setenv(refs.HOST_CONFIG_VARIABLE, str(hostcfg))
    token = tmp_path / "developer.token"
    token.write_text("secret-token\n", encoding="utf-8")
    config = tmp_path / "contexts.toml"
    config.write_text(f'[gitea]\nurl = "http://gitea.invalid"\ntoken_file = "{token}"\n', encoding="utf-8")
    gitea = FakeGitea(host)
    contexts = Contexts(home=tmp_path / "relay", config_path=config, gitea_factory=lambda cfg, tok: gitea)
    return {"host": host, "contexts": contexts, "gitea": gitea, "first": first, "tmp": tmp_path, "config": config}


def test_board_lists_catalog_sources_with_their_newest_publication(world):
    board = world["contexts"].board()
    assert board["catalog"]["state"] == "current"
    assert board["write"]["configured"] is True and board["write"]["owner"] == "developer"
    [row] = board["sources"]
    assert (row["id"], row["name"], row["status"]) == ("protoprey-refs", "ProtoPrey references", "active")
    assert row["head"]["revision"] == world["first"] and row["head"]["short"] == world["first"][:7]
    assert row["head"]["subject"] == "first" and row["head"]["state"] == "current"


def test_resolve_tree_and_file_are_pinned(world):
    contexts = world["contexts"]
    found = contexts.resolve("protoprey-refs", "latest")
    assert found["ref"] == f"protoprey-refs@{world['first']}"
    tree = contexts.tree("protoprey-refs", world["first"][:7])
    assert tree["revision"] == world["first"] and tree["readme"]["text"].startswith("# ProtoPrey")
    assert [f["path"] for f in tree["files"]] == ["README.md", "images/meadow.png"]
    data, kind, sha = contexts.file("protoprey-refs", world["first"], "images/meadow.png")
    assert (data, kind, sha) == (PNG, "image/png", world["first"])
    with pytest.raises(ContextsError, match="not a path"):
        contexts.file("protoprey-refs", world["first"], "../secret")


def test_create_publishes_a_readme_then_registers(world):
    contexts, gitea = world["contexts"], world["gitea"]
    found = contexts.create({"id": "pond-refs", "name": "Pond", "description": "Still water",
                             "readme": "# Pond\n\nStill water at noon.\n"})
    assert found["steps"] == ["repository created", "README published", "registered in the catalog"]
    assert gitea.created == ["pond-refs"]
    ids = [row["id"] for row in contexts.board()["sources"]]
    assert ids == ["pond-refs", "protoprey-refs"]
    # An independent consumer (an agent's own home) discovers it and reads the same bytes.
    agent_home = world["tmp"] / "agent" / ".local"
    agent_home.mkdir(parents=True)
    text = refs.show(f"pond-refs@{found['revision'][:7]}:README.md", base=agent_home)
    assert "Still water at noon." in text


def test_an_interrupted_creation_finishes_on_retry_without_duplicates(world, monkeypatch):
    contexts, gitea = world["contexts"], world["gitea"]
    original = Contexts._edit_catalog

    def broken(self, *args, **kwargs):
        raise ContextsError("network dropped", 502)

    monkeypatch.setattr(Contexts, "_edit_catalog", broken)
    with pytest.raises(ContextsError, match="network dropped"):
        contexts.create({"id": "pond-refs", "name": "Pond", "description": "Still water"})
    assert gitea.created == ["pond-refs"]
    assert "pond-refs" not in [row["id"] for row in contexts.board()["sources"]]
    monkeypatch.setattr(Contexts, "_edit_catalog", original)
    found = contexts.create({"id": "pond-refs", "name": "Pond", "description": "Still water"})
    assert found["steps"] == ["repository already existed", "first publication already made", "registered in the catalog"]
    assert gitea.created == ["pond-refs"]
    again = contexts.create({"id": "pond-refs", "name": "Pond", "description": "Still water"})
    assert again["steps"][-1] == "already registered" and again["revision"] == found["revision"]
    catalog = subprocess.run(["git", "show", "main:catalog.toml"], cwd=world["host"] / "developer" / "context-catalog",
                             capture_output=True, text=True).stdout
    assert catalog.count('id = "pond-refs"') == 1


def test_register_an_existing_repository(world):
    host, contexts = world["host"], world["contexts"]
    git("init", "-q", "--bare", "-b", "main", str(host / "developer" / "lore"), cwd=host)
    with pytest.raises(ContextsError, match="no commit"):
        contexts.register({"id": "lore", "repository": "developer/lore"})
    seed(host / "developer" / "lore", {"README.md": "# Lore\n"})
    found = contexts.register({"id": "lore", "repository": "developer/lore", "name": "Lore", "description": "World lore"})
    assert found["already"] is False
    assert contexts.register({"id": "lore", "repository": "developer/lore"})["already"] is True
    with pytest.raises(ContextsError, match="already registered"):
        contexts.register({"id": "lore", "repository": "developer/protoprey-refs"})


def test_rename_and_archive_keep_the_id_and_old_references(world):
    contexts = world["contexts"]
    old_ref = f"protoprey-refs@{world['first']}:README.md"
    found = contexts.update("protoprey-refs", {"name": "ProtoPrey (2026)", "description": "Updated blurb"})
    assert found["changed"] is True
    row = contexts.board()["sources"][0]
    assert (row["id"], row["name"], row["description"]) == ("protoprey-refs", "ProtoPrey (2026)", "Updated blurb")
    assert contexts.update("protoprey-refs", {"name": "ProtoPrey (2026)"})["changed"] is False
    contexts.update("protoprey-refs", {"status": "archived"})
    board = contexts.board()
    assert board["sources"] == [] and board["archived_hidden"] == 1
    assert contexts.board(include_archived=True)["sources"][0]["status"] == "archived"
    agent_home = world["tmp"] / "agent2" / ".local"
    agent_home.mkdir(parents=True)
    assert "Meadow at dusk" in refs.show(old_ref, base=agent_home)
    contexts.update("protoprey-refs", {"status": "active"})
    assert [row["id"] for row in contexts.board()["sources"]] == ["protoprey-refs"]


def test_publish_on_base_and_conflict_when_the_branch_moved(world):
    contexts, host = world["contexts"], world["host"]
    first = world["first"]
    image = base64.b64encode(PNG + b"new").decode()
    done = contexts.publish("protoprey-refs", {"base": first, "message": "pond still",
                                                "files": [{"path": "stories/pond.md", "text": "Still water.\n"},
                                                          {"path": "images/pond.png", "base64": image}]})
    second = done["revision"]
    assert done["files"] == ["stories/pond.md", "images/pond.png"]
    # The earlier reference still reads the earlier bytes; the new one reads the new.
    agent = world["tmp"] / "agent3" / ".local"
    agent.mkdir(parents=True)
    with pytest.raises(refs.RefsError, match="no such file"):
        refs.path_of(f"protoprey-refs@{first[:7]}:stories/pond.md", base=agent)
    assert refs.path_of(f"protoprey-refs@{second[:7]}:images/pond.png", base=agent).read_bytes() == PNG + b"new"
    # An editor still holding `first` is refused, with what moved.
    with pytest.raises(ContextsError) as refused:
        contexts.publish("protoprey-refs", {"base": first, "files": [{"path": "stories/pond.md", "text": "Mine\n"}]})
    assert refused.value.status == 409 and refused.value.extra["conflict"] is True
    assert refused.value.extra["head"] == second and refused.value.extra["touched"] == ["stories/pond.md"]
    # Somebody publishing with ordinary git in between is a conflict too.
    third = seed(host / "developer" / "protoprey-refs", {"stories/pond.md": "Frogs.\n"}, "git push")
    with pytest.raises(ContextsError) as moved:
        contexts.publish("protoprey-refs", {"base": second, "files": [{"path": "README.md", "text": "x\n"}]})
    assert moved.value.extra["head"] == third and moved.value.extra["touched"] == []
    # Publishing again on the newer base, on purpose, works.
    assert contexts.publish("protoprey-refs", {"base": third, "files": [{"path": "README.md", "text": "x\n"}]})["base"] == third
    log = (world["tmp"] / "relay" / "contexts" / "publications.jsonl").read_text().splitlines()
    assert [json.loads(line)["action"] for line in log] == ["publish", "publish"]


def test_writes_without_a_token_say_what_is_missing(world, tmp_path):
    config = tmp_path / "missing.toml"
    contexts = Contexts(home=tmp_path / "relay2", config_path=config)
    status = contexts.board()["write"]
    assert status["configured"] is False and "missing.toml is missing" in status["reason"]
    with pytest.raises(ContextsError) as refused:
        contexts.create({"id": "x"})
    assert refused.value.status == 503


def test_bad_input_is_refused(world):
    contexts = world["contexts"]
    with pytest.raises(ContextsError, match="not an id"):
        contexts.create({"id": "Bad Name"})
    with pytest.raises(ContextsError, match="base must be"):
        contexts.publish("protoprey-refs", {"base": "abc", "files": [{"path": "a.md", "text": "x"}]})
    with pytest.raises(ContextsError, match="not a path"):
        contexts.publish("protoprey-refs", {"base": world["first"], "files": [{"path": ".git/config", "text": "x"}]})
    with pytest.raises(ContextsError, match="nothing changed"):
        contexts.publish("protoprey-refs", {"base": world["first"],
                                            "files": [{"path": "README.md", "text": "# ProtoPrey\n\nMeadow at dusk.\n"}]})


def test_routes(world):
    server = build_server("127.0.0.1", 0, empty_room(), contexts=world["contexts"])
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    def call(method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(base + path, data=data, method=method,
                                         headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, response.read(), response.headers
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers

    try:
        status, body, _ = call("GET", "/contexts")
        assert status == 200 and json.loads(body)["sources"][0]["id"] == "protoprey-refs"
        status, body, _ = call("GET", "/contexts/protoprey-refs/resolve?rev=latest")
        assert json.loads(body)["revision"] == world["first"]
        status, body, headers = call("GET", f"/contexts/protoprey-refs/file?rev={world['first']}&path=images/meadow.png")
        assert status == 200 and body == PNG and "immutable" in headers["Cache-Control"]
        status, body, _ = call("GET", "/contexts/ghost/tree?rev=latest")
        assert status == 404
        status, body, _ = call("POST", "/contexts", {"id": "pond-refs", "name": "Pond", "description": "d"})
        assert status == 200 and json.loads(body)["ref"].startswith("pond-refs@")
        status, body, _ = call("POST", "/contexts/protoprey-refs/publish",
                               {"base": "0" * 40, "files": [{"path": "a.md", "text": "x"}]})
        assert status == 409 and json.loads(body)["conflict"] is True
        status, body, _ = call("POST", "/contexts/protoprey-refs", {"status": "archived"})
        assert status == 200 and json.loads(body)["status"] == "archived"
    finally:
        server.shutdown()


def test_init_creates_the_catalog_and_imports_registrations(tmp_path, monkeypatch):
    from agentroom.contexts import init_catalog

    host = tmp_path / "githost"
    (host / "developer").mkdir(parents=True)
    git("init", "-q", "--bare", "-b", "main", str(host / "developer" / "protoprey-refs"), cwd=tmp_path)
    seed(host / "developer" / "protoprey-refs", {"README.md": "# P\n"})
    catalog_url = host / "developer" / "context-catalog"
    hostcfg = tmp_path / "hostcfg.toml"
    hostcfg.write_text(f'[catalog]\nurl = "{catalog_url}"\n', encoding="utf-8")
    monkeypatch.setenv(refs.HOST_CONFIG_VARIABLE, str(hostcfg))
    agent_refs = tmp_path / "refs.toml"
    agent_refs.write_text(f'[[source]]\nname = "protoprey-refs"\nurl = "{host}/developer/protoprey-refs"\n'
                          'about = "ProtoPrey references"\n', encoding="utf-8")
    token = tmp_path / "t"
    token.write_text("x")
    config = tmp_path / "contexts.toml"
    config.write_text(f'[gitea]\nurl = "http://gitea.invalid"\ntoken_file = "{token}"\n', encoding="utf-8")
    gitea = FakeGitea(host)
    contexts = Contexts(home=tmp_path / "relay", config_path=config, gitea_factory=lambda cfg, tok: gitea)
    first = init_catalog(contexts, [agent_refs])
    assert first["steps"][0] == "created developer/context-catalog" and first["revision"]
    assert [row["id"] for row in contexts.board()["sources"]] == ["protoprey-refs"]
    assert init_catalog(contexts, [agent_refs])["revision"] is None
