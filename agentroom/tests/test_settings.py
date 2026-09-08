"""The settings repository door (`front_desk` p2 step 1), against a fixture
Git repository made in `tmp_path`.

What is pinned: a sync fetches, snapshots, checks and only then switches; a
sync that fails (a manifest naming a missing portrait, a ref that does not
exist, an unreachable URL) reports why and keeps the previous revision; a
character added in the repository appears after the next sync with no other
change; replacing the repository URL in the config is followed; every
revision synced stays retained and reachable by its id; the relay serves the
manifest with revision-addressed asset URLs and serves only the files the
manifest names. Nothing here touches the network.
"""

import json
import subprocess
import threading
from http.client import HTTPConnection
from pathlib import Path

import pytest

from agentroom.room import Room
from agentroom.server import build_server
from agentroom.settings import MANIFEST_SCHEMA, Settings, SettingsError, read_manifest

PNG = bytes.fromhex("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489")
JPG = bytes.fromhex("ffd8ffe000104a46494600010100000100010000ffd9")


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
        cwd=repo, capture_output=True, text=True, check=True,
    ).stdout.strip()


MANIFEST = """schema = "{schema}"

[characters.front]
name = "Front"
nickname = "姐さん"
lore = "characters/front/lore.md"
face = "characters/front/face.jpg"
agents = ["front"]

[rooms.front]
name = "Front Desk"
background = "rooms/front/bg.png"
"""


def make_repo(root: Path) -> Path:
    repo = root / "origin"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    write_character(repo, "front", "ユーザーの要望を聞く秘書のようなエージェント。")
    (repo / "rooms" / "front").mkdir(parents=True)
    (repo / "rooms" / "front" / "bg.png").write_bytes(PNG)
    (repo / "manifest.toml").write_text(MANIFEST.format(schema=MANIFEST_SCHEMA), encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "first")
    return repo


def write_character(repo: Path, cid: str, lore: str, face: bytes = JPG) -> None:
    (repo / "characters" / cid).mkdir(parents=True, exist_ok=True)
    (repo / "characters" / cid / "lore.md").write_text(lore, encoding="utf-8")
    (repo / "characters" / cid / "face.jpg").write_bytes(face)


def configure(root: Path, repo: Path, ref: str = "main", overrides: str = "") -> Path:
    local = root / "agdevworld" / ".local"
    local.mkdir(parents=True, exist_ok=True)
    config = local / "settings.toml"
    config.write_text(
        f'[repository]\nurl = "{repo.as_uri()}"\nref = "{ref}"\ndestination = ".local/settings"\n{overrides}',
        encoding="utf-8",
    )
    return config


@pytest.fixture
def fixture(tmp_path):
    repo = make_repo(tmp_path)
    config = configure(tmp_path, repo)
    return repo, Settings(config_path=config)


# --- the sync -----------------------------------------------------------------


def test_the_first_sync_clones_snapshots_checks_and_activates(fixture):
    repo, settings = fixture
    lines = []
    result = settings.sync(log=lines.append)
    head = git(repo, "rev-parse", "HEAD")
    assert result["ok"] and result["revision"] == head and result["changed"] is True
    assert result["characters"] == ["front"] and result["rooms"] == ["front"]
    destination = settings.config().destination
    assert destination == settings.config_path.parent.parent / ".local" / "settings"
    assert (destination / "revisions" / head / "characters" / "front" / "face.jpg").read_bytes() == JPG
    assert (destination / "current").resolve() == (destination / "revisions" / head).resolve()
    assert json.loads((destination / "active.json").read_text())["revision"] == head
    assert any("cloning" in line for line in lines)


def test_a_lore_and_image_change_becomes_the_next_revision_and_the_old_one_stays(fixture):
    repo, settings = fixture
    first = settings.sync()["revision"]
    write_character(repo, "front", "皆からは「姐さん」と呼ばれている。", face=JPG + b"v2")
    git(repo, "commit", "-qam", "lore and face")
    second = settings.sync()
    assert second["ok"] and second["changed"] and second["previous"] == first and second["revision"] != first
    now = settings.manifest()
    assert now.revision == second["revision"]
    assert "姐さん" in now.characters["front"].lore
    assert now.file("characters/front/face.jpg").read_bytes().endswith(b"v2")
    # The first revision is still readable by id, with its own portrait.
    old = settings.manifest(first)
    assert old.file("characters/front/face.jpg").read_bytes() == JPG
    assert "姐さん" not in old.characters["front"].lore


def test_an_unchanged_ref_is_a_sync_that_changes_nothing(fixture):
    _, settings = fixture
    first = settings.sync()
    again = settings.sync()
    assert again["ok"] and again["changed"] is False and again["revision"] == first["revision"]


def test_adding_a_character_is_a_settings_change_only(fixture):
    repo, settings = fixture
    settings.sync()
    write_character(repo, "autolab", "「親方」と呼ばれている。")
    manifest = (repo / "manifest.toml").read_text(encoding="utf-8") + (
        '\n[characters.autolab]\nname = "Autolab"\nnickname = "親方"\n'
        'lore = "characters/autolab/lore.md"\nface = "characters/autolab/face.jpg"\nagents = ["autolab"]\n'
    )
    (repo / "manifest.toml").write_text(manifest, encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "autolab")
    result = settings.sync()
    assert result["ok"] and result["characters"] == ["autolab", "front"]
    found = settings.manifest().characters["autolab"]
    assert found.name == "Autolab" and found.nickname == "親方" and found.agents == ["autolab"]
    assert settings.manifest().character_for(agent="autolab") == found


def test_a_manifest_naming_a_missing_file_fails_the_sync_and_keeps_the_previous_revision(fixture):
    repo, settings = fixture
    first = settings.sync()["revision"]
    (repo / "manifest.toml").write_text(
        (repo / "manifest.toml").read_text(encoding="utf-8").replace("face.jpg", "missing.jpg"), encoding="utf-8",
    )
    git(repo, "commit", "-qam", "broken")
    lines = []
    result = settings.sync(log=lines.append)
    assert result["ok"] is False and "missing.jpg" in result["error"] and result["kept"] == first
    assert settings.active()["revision"] == first
    assert settings.manifest().revision == first
    assert settings.last_sync()["ok"] is False and "missing.jpg" in settings.last_sync()["error"]
    assert any("keeping" in line for line in lines)
    # The relay's payload shows both: the working revision and why the last
    # sync did not replace it.
    snapshot = settings.snapshot()
    assert snapshot["active"]["revision"] == first and snapshot["manifest"]["revision"] == first
    assert snapshot["last_sync"]["ok"] is False


def test_a_ref_that_does_not_exist_fails_the_sync(fixture, tmp_path):
    repo, settings = fixture
    first = settings.sync()["revision"]
    configure(tmp_path, repo, ref="nope")
    result = settings.sync()
    assert result["ok"] is False and "'nope'" in result["error"] and result["kept"] == first
    assert settings.active()["revision"] == first


def test_an_unreachable_repository_fails_the_first_sync_with_nothing_active(tmp_path):
    config = configure(tmp_path, tmp_path / "nowhere")
    settings = Settings(config_path=config)
    result = settings.sync()
    assert result["ok"] is False and result["kept"] is None
    assert settings.active() is None
    snapshot = settings.snapshot()
    assert snapshot["manifest"] is None and "no settings revision is active" in snapshot["error"]
    assert snapshot["last_sync"]["ok"] is False


def test_replacing_the_repository_in_the_config_is_followed(fixture, tmp_path):
    repo, settings = fixture
    first = settings.sync()["revision"]
    other = tmp_path / "other"
    other.mkdir()
    git(other, "init", "-q", "-b", "main")
    write_character(other, "front", "別のリポジトリのフロント。")
    (other / "rooms" / "front").mkdir(parents=True)
    (other / "rooms" / "front" / "bg.png").write_bytes(PNG)
    (other / "manifest.toml").write_text(MANIFEST.format(schema=MANIFEST_SCHEMA), encoding="utf-8")
    git(other, "add", "-A")
    git(other, "commit", "-qm", "other first")
    configure(tmp_path, other)
    lines = []
    result = settings.sync(log=lines.append)
    assert result["ok"] and result["revision"] == git(other, "rev-parse", "HEAD") and result["previous"] == first
    assert "別のリポジトリ" in settings.manifest().characters["front"].lore
    assert any("→" in line for line in lines)
    # The revision from the first repository is still retained.
    assert settings.manifest(first).revision == first


def test_a_tag_or_a_commit_id_is_a_usable_ref(fixture, tmp_path):
    repo, settings = fixture
    first = settings.sync()["revision"]
    write_character(repo, "front", "second")
    git(repo, "commit", "-qam", "second")
    git(repo, "tag", "v1")
    configure(tmp_path, repo, ref="v1")
    assert settings.sync()["revision"] == git(repo, "rev-parse", "v1")
    configure(tmp_path, repo, ref=first)
    assert settings.sync()["revision"] == first


# --- the manifest -------------------------------------------------------------


def test_the_manifest_is_checked_whole(tmp_path):
    root = tmp_path / "rev"
    root.mkdir()
    with pytest.raises(SettingsError, match="missing"):
        read_manifest(root, "abc1234", {})
    (root / "manifest.toml").write_text('schema = "other"\n', encoding="utf-8")
    with pytest.raises(SettingsError, match="schema"):
        read_manifest(root, "abc1234", {})
    (root / "manifest.toml").write_text(f'schema = "{MANIFEST_SCHEMA}"\n', encoding="utf-8")
    with pytest.raises(SettingsError, match="no characters"):
        read_manifest(root, "abc1234", {})
    (root / "manifest.toml").write_text(
        f'schema = "{MANIFEST_SCHEMA}"\n[characters.x]\nname = "X"\nlore = "../x.md"\nface = "x.jpg"\n', encoding="utf-8",
    )
    with pytest.raises(SettingsError, match="relative path"):
        read_manifest(root, "abc1234", {})
    write_character(root, "x", "")
    (root / "manifest.toml").write_text(
        f'schema = "{MANIFEST_SCHEMA}"\n[characters.x]\nname = "X"\nlore = "characters/x/lore.md"\nface = "characters/x/face.jpg"\n',
        encoding="utf-8",
    )
    with pytest.raises(SettingsError, match="empty"):
        read_manifest(root, "abc1234", {})


def test_local_overrides_extend_the_agent_mapping_without_touching_the_repository(fixture, tmp_path):
    repo, settings = fixture
    configure(tmp_path, repo, overrides='[overrides.characters.front]\nagents = ["front-agstudio1"]\nsenders = ["Front"]\n')
    settings.sync()
    found = settings.manifest().characters["front"]
    assert found.agents == ["front", "front-agstudio1"] and found.senders == ["Front"]
    assert settings.manifest().character_for(sender="Front") == found
    assert settings.manifest().character_for(agent="nobody") is None
    assert "front-agstudio1" not in (repo / "manifest.toml").read_text(encoding="utf-8")


# --- the relay ----------------------------------------------------------------


@pytest.fixture
def served(fixture):
    _, settings = fixture
    settings.sync()
    server = build_server("127.0.0.1", 0, Room(env_path=Path(__file__)), settings=settings)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield settings, server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()


def get(port, path):
    connection = HTTPConnection("127.0.0.1", port, timeout=5)
    connection.request("GET", path)
    response = connection.getresponse()
    body = response.read()
    headers = dict(response.getheaders())
    connection.close()
    return response.status, headers, body


def test_the_relay_serves_the_active_manifest_with_revision_addressed_assets(served):
    settings, port = served
    status, _, body = get(port, "/settings")
    assert status == 200
    payload = json.loads(body)
    revision = settings.active()["revision"]
    assert payload["active"]["revision"] == revision and payload["error"] is None
    front = payload["manifest"]["characters"]["front"]
    assert front["face"] == f"/settings/{revision}/characters/front/face.jpg"
    assert front["nickname"] == "姐さん" and "秘書" in front["lore"]
    assert payload["manifest"]["rooms"]["front"]["background"] == f"/settings/{revision}/rooms/front/bg.png"
    status, headers, body = get(port, front["face"])
    assert status == 200 and body == JPG and headers["Content-Type"] == "image/jpeg"
    assert "immutable" in headers["Cache-Control"]
    status, headers, _ = get(port, payload["manifest"]["rooms"]["front"]["background"])
    assert status == 200 and headers["Content-Type"] == "image/png"


def test_the_relay_serves_only_what_the_manifest_names(served):
    settings, port = served
    revision = settings.active()["revision"]
    assert get(port, f"/settings/{revision}/manifest.toml")[0] == 200
    assert get(port, f"/settings/{revision}/characters/front/lore.md")[0] == 200
    assert get(port, f"/settings/{revision}/../active.json")[0] == 404
    assert get(port, f"/settings/{revision}/characters/front/other.jpg")[0] == 404
    assert get(port, "/settings/deadbeefdead/characters/front/face.jpg")[0] == 404
    status, _, body = get(port, "/settings/deadbeefdead")
    assert status == 404 and json.loads(body)["retained"] is False


def test_a_retained_revision_answers_by_id_after_the_active_one_moved_on(served, fixture):
    repo, settings = fixture
    _, port = served
    first = settings.active()["revision"]
    write_character(repo, "front", "changed", face=JPG + b"v2")
    git(repo, "commit", "-qam", "v2")
    settings.sync()
    second = settings.active()["revision"]
    assert first != second
    # No restart in between: the same server now answers with the new one...
    assert json.loads(get(port, "/settings")[2])["active"]["revision"] == second
    # ...and still the old one by id, with the old portrait.
    status, _, body = get(port, f"/settings/{first}")
    assert status == 200 and json.loads(body)["retained"] is True
    assert get(port, f"/settings/{first}/characters/front/face.jpg")[2] == JPG
    assert get(port, f"/settings/{second}/characters/front/face.jpg")[2] == JPG + b"v2"


def test_an_unconfigured_relay_says_so(tmp_path):
    settings = Settings(config_path=tmp_path / "absent.toml")
    snapshot = settings.snapshot()
    assert snapshot["manifest"] is None and "cannot be read" in snapshot["error"]
