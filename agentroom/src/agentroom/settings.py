"""The settings repository: characters, lore, portraits, room backgrounds.

`front_desk` p2 moves the Front Desk's content — who the characters are,
what they look like, what the room looks like — out of the frontend bundle
and out of agfront's guide into a Git repository of its own
(`iwaag/agdevworld-settings` to begin with; the URL is configuration). This
module is the whole of how a running agdevworld gets at it:

- **a config file**, ignored, with a tracked example beside it
  (`agdevworld/settings.example.toml` → `agdevworld/.local/settings.toml`):
  the repository URL, the ref to follow, where to keep it, and the local
  overrides that map this realm's agents onto the characters;
- **an explicit sync** (`agentroom-settings sync`): fetch, resolve the ref,
  snapshot that commit, check that its manifest and every file it names are
  usable, and only then switch the *active revision*. A sync that fails
  reports why and leaves the previous revision active. Nothing fetches on a
  conversation; a timer may run the same command later;
- **revisions that stay.** Every synced commit is kept as a plain snapshot
  under `revisions/<sha>/`, so a dialogue saved against a revision can still
  be drawn with the faces it was written for after the content moves on. The
  active one is also reachable as `current/`, a symlink, which is the stable
  path an agent workspace reads lore from;
- **the relay's read**: `GET /settings` (the active manifest, with every
  asset addressed by revision so a browser cache never keeps a replaced
  image), `GET /settings/<sha>` (a retained revision's manifest) and
  `GET /settings/<sha>/<path>` (a file the manifest names — and only those,
  which is what keeps this from being a file server).

The manifest (`manifest.toml`, `ag.settings-manifest.v1`) is the settings
repository's own index: display names, lore and portrait paths, which agents
speak as which character, and each room's background. Adding a character is
a manifest entry plus its files, in that repository; nothing here changes.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Callable

SCHEMA = "ag.settings.v1"
MANIFEST_SCHEMA = "ag.settings-manifest.v1"
ACTIVE_SCHEMA = "ag.settings-active.v1"
MANIFEST_FILE = "manifest.toml"
#: The config file, a path in the environment because it is a local path.
CONFIG_VARIABLE = "AGENTROOM_SETTINGS_CONFIG"
#: `agdevworld/` — three directories up from this package under `src/`.
AGDEVWORLD_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONFIG = AGDEVWORLD_ROOT / ".local" / "settings.toml"
DEFAULT_DESTINATION = ".local/settings"
DEFAULT_REF = "main"
GIT_TIMEOUT_SECONDS = 120
#: What a revision's file is served as. Anything else the manifest names is
#: served as bytes.
CONTENT_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8", ".toml": "text/plain; charset=utf-8",
    ".json": "application/json",
}

__all__ = [
    "AGDEVWORLD_ROOT", "CONFIG_VARIABLE", "DEFAULT_CONFIG", "MANIFEST_FILE", "MANIFEST_SCHEMA",
    "SCHEMA", "Character", "Config", "Manifest", "Room", "Settings", "SettingsError",
    "read_manifest", "main",
]


class SettingsError(Exception):
    """A config, a sync or a manifest that cannot be used, with the reason."""


# --- configuration ---------------------------------------------------------------


@dataclass(frozen=True)
class Config:
    url: str
    ref: str
    destination: Path
    #: `[overrides.characters.<id>]` — this realm's additions to the
    #: manifest's agent mapping (`agents`, `senders`), never in the repository
    #: because they name instances of this realm.
    overrides: dict = field(default_factory=dict)
    path: Path | None = None

    @classmethod
    def load(cls, path: Path) -> "Config":
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as error:
            raise SettingsError(f"settings config {path} cannot be read: {error}") from error
        try:
            data = tomllib.loads(text)
        except tomllib.TOMLDecodeError as error:
            raise SettingsError(f"settings config {path} is not valid TOML: {error}") from error
        repository = data.get("repository")
        if not isinstance(repository, dict) or not str(repository.get("url") or "").strip():
            raise SettingsError(f"settings config {path} needs [repository] url")
        destination = Path(str(repository.get("destination") or DEFAULT_DESTINATION)).expanduser()
        if not destination.is_absolute():
            destination = path.parent.parent / destination if path.parent.name == ".local" else path.parent / destination
        overrides = data.get("overrides") or {}
        if not isinstance(overrides, dict):
            raise SettingsError(f"settings config {path}: [overrides] must be a table")
        return cls(
            url=str(repository["url"]).strip(),
            ref=str(repository.get("ref") or DEFAULT_REF).strip(),
            destination=destination.resolve(),
            overrides=overrides,
            path=path,
        )

    @property
    def repo(self) -> Path:
        return self.destination / "repo"

    @property
    def revisions(self) -> Path:
        return self.destination / "revisions"

    @property
    def active_file(self) -> Path:
        return self.destination / "active.json"

    @property
    def last_sync_file(self) -> Path:
        return self.destination / "last_sync.json"

    @property
    def current(self) -> Path:
        return self.destination / "current"


# --- the manifest ------------------------------------------------------------------


@dataclass
class Character:
    id: str
    name: str
    nickname: str | None
    lore_path: str
    face_path: str
    lore: str
    agents: list[str]
    senders: list[str]

    def payload(self, prefix: str) -> dict:
        return {
            "id": self.id, "name": self.name, "nickname": self.nickname,
            "agents": list(self.agents), "senders": list(self.senders),
            "lore": self.lore, "lore_path": self.lore_path,
            "face": f"{prefix}/{self.face_path}", "face_path": self.face_path,
        }


@dataclass
class Room:
    id: str
    name: str
    background_path: str

    def payload(self, prefix: str) -> dict:
        return {"id": self.id, "name": self.name,
                "background": f"{prefix}/{self.background_path}",
                "background_path": self.background_path}


@dataclass
class Manifest:
    revision: str
    root: Path
    characters: dict[str, Character]
    rooms: dict[str, Room]

    @property
    def files(self) -> set[str]:
        """Every repository-relative file the manifest names — the whole of
        what the relay will serve for this revision."""
        found = {MANIFEST_FILE}
        for character in self.characters.values():
            found.update((character.lore_path, character.face_path))
        for room in self.rooms.values():
            found.add(room.background_path)
        return found

    def file(self, relpath: str) -> Path | None:
        """The snapshot's file for a manifest-named path, else None."""
        return self.root / relpath if relpath in self.files else None

    def payload(self, prefix: str) -> dict:
        """The manifest as the browser and the agents see it: every asset
        addressed under `<prefix>/…`, which carries the revision."""
        return {
            "schema": MANIFEST_SCHEMA, "revision": self.revision,
            "characters": {cid: c.payload(prefix) for cid, c in self.characters.items()},
            "rooms": {rid: r.payload(prefix) for rid, r in self.rooms.items()},
        }

    def character_for(self, *, agent: str | None = None, sender: str | None = None) -> Character | None:
        """Which character an agent (by its `agent` name) or a Zulip sender
        (by display name) speaks as; None when the manifest does not say."""
        for character in self.characters.values():
            if agent is not None and agent in character.agents:
                return character
            if sender is not None and sender in character.senders:
                return character
        return None


def _relpath(value, label: str) -> str:
    text = str(value or "").strip()
    pure = PurePosixPath(text)
    if not text or pure.is_absolute() or ".." in pure.parts or text.startswith("./"):
        raise SettingsError(f"{label} must be a relative path inside the repository, not {text!r}")
    return pure.as_posix()


def _names(value, label: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(one, str) for one in value):
        raise SettingsError(f"{label} must be a list of strings")
    return [one.strip() for one in value if one.strip()]


def read_manifest(root: Path, revision: str, overrides: dict | None = None) -> Manifest:
    """Read and check one revision's manifest; every named file must exist.

    Raising here is what a failed sync is made of: a manifest that names a
    portrait the commit does not contain is not usable, and the previous
    revision stays active.
    """
    path = root / MANIFEST_FILE
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise SettingsError(f"{MANIFEST_FILE} is missing from revision {revision[:12]}: {error}") from error
    except tomllib.TOMLDecodeError as error:
        raise SettingsError(f"{MANIFEST_FILE} at {revision[:12]} is not valid TOML: {error}") from error
    if data.get("schema") != MANIFEST_SCHEMA:
        raise SettingsError(f"{MANIFEST_FILE} at {revision[:12]} declares schema {data.get('schema')!r}, "
                            f"not {MANIFEST_SCHEMA!r}")
    character_overrides = ((overrides or {}).get("characters") or {})
    if not isinstance(character_overrides, dict):
        raise SettingsError("[overrides.characters] must be a table")
    characters: dict[str, Character] = {}
    for cid, entry in (data.get("characters") or {}).items():
        if not isinstance(entry, dict):
            raise SettingsError(f"characters.{cid} must be a table")
        name = str(entry.get("name") or "").strip()
        if not name:
            raise SettingsError(f"characters.{cid} has no name")
        lore_path = _relpath(entry.get("lore"), f"characters.{cid}.lore")
        face_path = _relpath(entry.get("face"), f"characters.{cid}.face")
        try:
            lore = (root / lore_path).read_text(encoding="utf-8").strip()
        except OSError as error:
            raise SettingsError(f"characters.{cid}: lore {lore_path} cannot be read at "
                                f"{revision[:12]}: {error}") from error
        if not lore:
            raise SettingsError(f"characters.{cid}: lore {lore_path} is empty at {revision[:12]}")
        if not (root / face_path).is_file():
            raise SettingsError(f"characters.{cid}: face {face_path} is missing at {revision[:12]}")
        extra = character_overrides.get(cid) or {}
        if not isinstance(extra, dict):
            raise SettingsError(f"[overrides.characters.{cid}] must be a table")
        agents = _names(entry.get("agents"), f"characters.{cid}.agents")
        agents += [one for one in _names(extra.get("agents"), f"overrides.characters.{cid}.agents") if one not in agents]
        senders = _names(entry.get("senders"), f"characters.{cid}.senders")
        senders += [one for one in _names(extra.get("senders"), f"overrides.characters.{cid}.senders") if one not in senders]
        nickname = entry.get("nickname")
        characters[cid] = Character(
            id=cid, name=name, nickname=(str(nickname).strip() or None) if nickname is not None else None,
            lore_path=lore_path, face_path=face_path, lore=lore, agents=agents, senders=senders,
        )
    if not characters:
        raise SettingsError(f"{MANIFEST_FILE} at {revision[:12]} names no characters")
    rooms: dict[str, Room] = {}
    for rid, entry in (data.get("rooms") or {}).items():
        if not isinstance(entry, dict):
            raise SettingsError(f"rooms.{rid} must be a table")
        background = _relpath(entry.get("background"), f"rooms.{rid}.background")
        if not (root / background).is_file():
            raise SettingsError(f"rooms.{rid}: background {background} is missing at {revision[:12]}")
        rooms[rid] = Room(id=rid, name=str(entry.get("name") or rid).strip() or rid, background_path=background)
    return Manifest(revision=revision, root=root, characters=characters, rooms=rooms)


# --- git ----------------------------------------------------------------------------


def _git(args: list[str], cwd: Path | None = None) -> str:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"}
    try:
        done = subprocess.run(
            ["git", *args], cwd=cwd, env=env, capture_output=True, text=True,
            timeout=GIT_TIMEOUT_SECONDS, check=False,
        )
    except FileNotFoundError as error:
        raise SettingsError("git is not on PATH") from error
    except subprocess.TimeoutExpired as error:
        raise SettingsError(f"git {' '.join(args[:2])} timed out after {GIT_TIMEOUT_SECONDS}s") from error
    if done.returncode != 0:
        detail = (done.stderr or done.stdout).strip().splitlines()
        raise SettingsError(f"git {' '.join(args[:2])} failed: {detail[-1] if detail else done.returncode}")
    return done.stdout.strip()


def _atomic_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile("w", dir=path.parent, prefix=f".{path.name}.", delete=False, encoding="utf-8")
    with handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(handle.name, path)


def _atomic_symlink(link: Path, target: str) -> None:
    temp = link.parent / f".{link.name}.{os.getpid()}"
    if temp.is_symlink() or temp.exists():
        temp.unlink()
    os.symlink(target, temp)
    os.replace(temp, link)


# --- the settings, as a service ---------------------------------------------------


@dataclass
class Settings:
    """The active revision and its retained siblings, read per request.

    Nothing is cached across requests on purpose: `sync` switches the active
    revision by replacing one small file, and the next `GET /settings` sees
    it. That is the "no restart for a content update" rule in one line.
    """

    config_path: Path = DEFAULT_CONFIG
    #: Where the served assets are addressed: `<prefix>/<revision>/<path>`.
    route_prefix: str = "/settings"

    # -- configuration and state -----------------------------------------

    def config(self) -> Config:
        return Config.load(self.config_path)

    def active(self, config: Config | None = None) -> dict | None:
        try:
            config = config or self.config()
            data = json.loads(config.active_file.read_text(encoding="utf-8"))
        except (SettingsError, OSError, ValueError):
            return None
        if not isinstance(data, dict) or not data.get("revision"):
            return None
        return data

    def last_sync(self, config: Config | None = None) -> dict | None:
        try:
            config = config or self.config()
            data = json.loads(config.last_sync_file.read_text(encoding="utf-8"))
        except (SettingsError, OSError, ValueError):
            return None
        return data if isinstance(data, dict) else None

    def revision_root(self, config: Config, revision: str) -> Path | None:
        if not revision or not all(c in "0123456789abcdef" for c in revision) or len(revision) < 7:
            return None
        root = config.revisions / revision
        return root if root.is_dir() else None

    def manifest(self, revision: str | None = None) -> Manifest:
        """The active revision's manifest, or a retained one's."""
        config = self.config()
        if revision is None:
            active = self.active(config)
            if active is None:
                raise SettingsError("no settings revision is active yet; run `agentroom-settings sync`")
            revision = str(active["revision"])
        root = self.revision_root(config, revision)
        if root is None:
            raise SettingsError(f"settings revision {revision[:12]} is not retained here")
        return read_manifest(root, revision, config.overrides)

    # -- what the relay answers ---------------------------------------------

    def snapshot(self, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        payload: dict = {"schema": SCHEMA, "generated_at": now, "config": None,
                         "active": None, "last_sync": None, "manifest": None, "error": None}
        try:
            config = self.config()
        except SettingsError as error:
            payload["error"] = f"{error} ({CONFIG_VARIABLE} or {DEFAULT_CONFIG.name} decides the file)"
            return payload
        payload["config"] = {"url": config.url, "ref": config.ref, "path": str(config.path)}
        payload["last_sync"] = self.last_sync(config)
        active = self.active(config)
        if active is None:
            payload["error"] = "no settings revision is active yet; run `agentroom-settings sync`"
            return payload
        payload["active"] = active
        try:
            manifest = self.manifest(str(active["revision"]))
        except SettingsError as error:
            payload["error"] = str(error)
            return payload
        payload["manifest"] = manifest.payload(f"{self.route_prefix}/{manifest.revision}")
        return payload

    def revision(self, revision: str) -> dict:
        """One retained revision's manifest, for a dialogue saved against it."""
        try:
            manifest = self.manifest(revision)
        except SettingsError as error:
            return {"schema": SCHEMA, "revision": revision, "retained": False, "error": str(error)}
        return {"schema": SCHEMA, "revision": manifest.revision, "retained": True,
                "manifest": manifest.payload(f"{self.route_prefix}/{manifest.revision}")}

    def asset(self, revision: str, relpath: str) -> tuple[bytes, str] | None:
        """A manifest-named file of one retained revision, or None."""
        try:
            manifest = self.manifest(revision)
        except SettingsError:
            return None
        path = manifest.file(relpath)
        if path is None or not path.is_file():
            return None
        return path.read_bytes(), CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")

    # -- the sync -----------------------------------------------------------

    def sync(self, log: Callable[[str], None] = lambda _: None) -> dict:
        """Fetch, snapshot, check, switch — or report and keep what was active.

        The result says what happened either way; a failure is also written
        to `last_sync.json`, so the relay can show the reason beside the
        revision that is still in use.
        """
        started = time.time()
        try:
            config = self.config()
        except SettingsError as error:
            return {"ok": False, "error": str(error), "revision": None, "at": started}
        previous = self.active(config)
        try:
            revision = self._fetch(config, log)
            root = self._snapshot(config, revision, log)
            manifest = read_manifest(root, revision, config.overrides)
        except SettingsError as error:
            result = {"ok": False, "error": str(error), "at": started, "url": config.url, "ref": config.ref,
                      "revision": None, "kept": (previous or {}).get("revision")}
            _atomic_json(config.last_sync_file, result)
            log(f"sync failed: {error}; keeping {result['kept'] or 'nothing'} active")
            return result
        changed = (previous or {}).get("revision") != revision
        active = {"schema": ACTIVE_SCHEMA, "revision": revision, "short": revision[:12],
                  "url": config.url, "ref": config.ref, "synced_at": started,
                  "characters": sorted(manifest.characters), "rooms": sorted(manifest.rooms)}
        _atomic_json(config.active_file, active)
        _atomic_symlink(config.current, f"revisions/{revision}")
        result = {"ok": True, "error": None, "at": started, "url": config.url, "ref": config.ref,
                  "revision": revision, "changed": changed, "previous": (previous or {}).get("revision"),
                  "characters": sorted(manifest.characters), "rooms": sorted(manifest.rooms)}
        _atomic_json(config.last_sync_file, result)
        log(f"active revision {revision[:12]} ({'new' if changed else 'unchanged'}); "
            f"characters: {', '.join(result['characters'])}")
        return result

    def _fetch(self, config: Config, log: Callable[[str], None]) -> str:
        repo = config.repo
        config.destination.mkdir(parents=True, exist_ok=True)
        if not (repo / ".git").is_dir():
            if repo.exists():
                shutil.rmtree(repo)
            log(f"cloning {config.url}")
            _git(["clone", "--quiet", "--no-checkout", config.url, str(repo)])
        else:
            origin = _git(["remote", "get-url", "origin"], cwd=repo)
            if origin != config.url:
                # The repository was replaced in the config: follow it in the
                # same clone rather than leaving a stale one behind.
                log(f"origin {origin} → {config.url}")
                _git(["remote", "set-url", "origin", config.url], cwd=repo)
        log(f"fetching {config.ref} from {config.url}")
        _git(["fetch", "--quiet", "--prune", "--tags", "--force", "origin"], cwd=repo)
        for candidate in (f"refs/remotes/origin/{config.ref}", f"refs/tags/{config.ref}", config.ref):
            try:
                return _git(["rev-parse", "--verify", "--quiet", f"{candidate}^{{commit}}"], cwd=repo)
            except SettingsError:
                continue
        raise SettingsError(f"ref {config.ref!r} was not found in {config.url}")

    def _snapshot(self, config: Config, revision: str, log: Callable[[str], None]) -> Path:
        root = config.revisions / revision
        if root.is_dir():
            return root
        config.revisions.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=f".{revision[:12]}.", dir=config.revisions))
        try:
            archive = subprocess.run(
                ["git", "archive", "--format=tar", revision], cwd=config.repo,
                capture_output=True, timeout=GIT_TIMEOUT_SECONDS, check=False,
            )
            if archive.returncode != 0:
                raise SettingsError(f"git archive {revision[:12]} failed: {archive.stderr.decode(errors='replace').strip()}")
            extract = subprocess.run(["tar", "-x", "-C", str(staging)], input=archive.stdout,
                                     capture_output=True, timeout=GIT_TIMEOUT_SECONDS, check=False)
            if extract.returncode != 0:
                raise SettingsError(f"unpacking {revision[:12]} failed: {extract.stderr.decode(errors='replace').strip()}")
            os.replace(staging, root)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise SettingsError(f"snapshot of {revision[:12]} failed: {error}") from error
        finally:
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
        log(f"retained revision {revision[:12]}")
        return root


def settings_from_env() -> Settings:
    found = os.environ.get(CONFIG_VARIABLE, "")
    return Settings(config_path=Path(found).expanduser() if found else DEFAULT_CONFIG)


# --- the command --------------------------------------------------------------------


USAGE = """usage: agentroom-settings <command>

  sync     fetch the configured repository, check the ref's manifest and
           every file it names, and make that revision the active one; a
           failure reports why and keeps the previous revision
  status   the active revision, the last sync and the characters it names
  show     the active manifest as the relay serves it (JSON)

The config file is $AGENTROOM_SETTINGS_CONFIG or agdevworld/.local/settings.toml;
`settings.example.toml` beside agdevworld's package.json shows the shape."""


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    settings = settings_from_env()
    command = argv[0] if argv else "status"
    if command == "sync":
        result = settings.sync(log=lambda line: print(line, file=sys.stderr, flush=True))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["ok"] else 1
    if command == "status":
        snapshot = settings.snapshot()
        print(f"config: {snapshot['config'] or snapshot['error']}")
        active = snapshot["active"]
        print("active: " + (f"{active['short']} ({active['ref']} of {active['url']})" if active else "none"))
        last = snapshot["last_sync"]
        if last:
            print("last sync: " + ("ok" if last.get("ok") else f"FAILED — {last.get('error')}")
                  + f" at {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(last.get('at') or 0))}")
        manifest = snapshot["manifest"]
        if manifest:
            for cid, character in manifest["characters"].items():
                print(f"  character {cid:<12} {character['name']} agents={character['agents']} face={character['face_path']}")
            for rid, room in manifest["rooms"].items():
                print(f"  room      {rid:<12} {room['name']} background={room['background_path']}")
        elif snapshot["error"]:
            print(f"error: {snapshot['error']}")
        return 0 if manifest else 1
    if command == "show":
        print(json.dumps(settings.snapshot(), ensure_ascii=False, indent=2))
        return 0
    print(USAGE, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
