"""Context repositories: the shared catalog, read and managed from agdevworld.

`give_context_easier` p1. A *context repository* is a git repository the
Developer publishes for every agent to read — stories, images, templates,
anything a project is built from. Which ones exist is one small catalog
repository (`catalog.toml`, pyagag `agag.refs`), so registering one reaches
every agent without editing anything per agent.

This module is the relay's half:

- **reads** (`board`, `resolve`, `tree`, `file`) go through the same pyagag
  functions the agents run (`agag.refs`), with the relay's own cache under
  `agentroom/.local/refs/`, so the browser and the agents cannot disagree
  about the set of sources or about what a commit contains;
- **writes** (`create`, `register`, `update`, `publish`) are the Developer's
  explicit actions from the panel, made with the Developer's Gitea token
  (`token_file` in the ignored `agdevworld/.local/contexts.toml`) and no model
  run. A publication is a commit on a named base revision, pushed without
  force: when the branch has moved since the editor loaded it, nothing is
  written and the answer says what moved, so a newer publication is never
  silently overwritten. Each one is appended to
  `agentroom/.local/contexts/publications.jsonl`.

A new repository is registered in the catalog only after its first
publication, because an empty repository cannot produce a pinned reference.
A creation cut short (repository created, README not yet pushed, or pushed
and not yet registered) is finished by repeating it; the repository name is
the id, so a retry can never make a second one.
"""

from __future__ import annotations

import base64
import binascii
import json
import mimetypes
import os
import subprocess
import tempfile
import threading
import time
import tomllib
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable
from urllib.parse import quote, urlsplit

from agag import refs

CONFIG_VARIABLE = "AGENTROOM_CONTEXTS_CONFIG"
AGDEVWORLD_ROOT = Path(__file__).resolve().parents[3]
PACKAGE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = AGDEVWORLD_ROOT / ".local" / "contexts.toml"
DEFAULT_HOME = PACKAGE_ROOT / ".local"
HEAD_TTL_SECONDS = 30.0
README_LIMIT = 60_000
FILE_LIMIT = 20 * 1024 * 1024
PUBLISH_LIMIT = 40 * 1024 * 1024
CATALOG_RETRIES = 3
GIT_TIMEOUT = 120
TEXT_TYPES = {".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
              ".toml": "text/plain; charset=utf-8", ".json": "application/json", ".csv": "text/csv; charset=utf-8"}

__all__ = ["Contexts", "ContextsError", "Gitea", "contexts_from_env"]


class ContextsError(Exception):
    """A request the relay declines, with the HTTP status that says why."""

    def __init__(self, message: str, status: int = 400, **extra) -> None:
        super().__init__(message)
        self.status = status
        self.extra = extra


# --- configuration -------------------------------------------------------------


@dataclass(frozen=True)
class WriteConfig:
    token_file: Path | None
    api: str | None
    owner: str | None
    author_name: str | None
    author_email: str | None
    path: Path | None
    error: str | None = None


def load_write_config(path: Path) -> WriteConfig:
    if not path.is_file():
        return WriteConfig(None, None, None, None, None, path,
                           error=f"{path.name} is missing: its [gitea] token_file names the Developer's Gitea token")
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        return WriteConfig(None, None, None, None, None, path, error=f"{path}: {error}")
    gitea = data.get("gitea") or {}
    author = data.get("author") or {}
    token = str(gitea.get("token_file") or "").strip()
    token_file = None
    if token:
        token_file = Path(token).expanduser()
        if not token_file.is_absolute():
            token_file = (path.parent / token_file).resolve()
    return WriteConfig(
        token_file=token_file,
        api=str(gitea.get("url") or "").strip().rstrip("/") or None,
        owner=str(gitea.get("owner") or "").strip() or None,
        author_name=str(author.get("name") or "").strip() or None,
        author_email=str(author.get("email") or "").strip() or None,
        path=path,
        error=None if token_file else f"{path.name} names no [gitea] token_file",
    )


# --- Gitea ---------------------------------------------------------------------------


class Gitea:
    """The few Gitea API calls creation needs, with the Developer's token."""

    def __init__(self, api: str, token: str, timeout: float = 30.0) -> None:
        self.api = api.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _call(self, method: str, path: str, body: dict | None = None):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(f"{self.api}/api/v1{path}", data=data, method=method)
        request.add_header("Authorization", f"token {self.token}")
        request.add_header("Accept", "application/json")
        if data is not None:
            request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
                return response.status, (json.loads(raw) if raw.strip() else None)
        except urllib.error.HTTPError as error:
            raw = error.read()
            try:
                payload = json.loads(raw) if raw.strip() else None
            except ValueError:
                payload = {"message": raw.decode("utf-8", "replace")[:300]}
            return error.code, payload
        except (urllib.error.URLError, OSError, TimeoutError) as error:
            raise ContextsError(f"Gitea at {self.api} cannot be reached: {error}", 502) from error

    def user(self) -> dict:
        status, payload = self._call("GET", "/user")
        if status != 200:
            raise ContextsError(f"Gitea refused the token ({status}: {(payload or {}).get('message')})", 503)
        return payload

    def repo(self, owner: str, name: str) -> dict | None:
        status, payload = self._call("GET", f"/repos/{quote(owner)}/{quote(name)}")
        if status == 404:
            return None
        if status != 200:
            raise ContextsError(f"Gitea answered {status} for {owner}/{name}: {(payload or {}).get('message')}", 502)
        return payload

    def create_repo(self, name: str, description: str, branch: str) -> dict:
        status, payload = self._call("POST", "/user/repos", {
            "name": name, "description": description, "private": False,
            "auto_init": False, "default_branch": branch,
        })
        if status not in (200, 201):
            raise ContextsError(f"Gitea could not create {name} ({status}: {(payload or {}).get('message')})", 502)
        return payload

    def set_description(self, owner: str, name: str, description: str) -> None:
        status, payload = self._call("PATCH", f"/repos/{quote(owner)}/{quote(name)}", {"description": description})
        if status not in (200, 201):
            raise ContextsError(f"Gitea could not update {owner}/{name} ({status}: {(payload or {}).get('message')})", 502)


# --- git plumbing for publication ---------------------------------------------------


def _git(args: list[str], cwd: Path, env: dict | None = None, input_bytes: bytes | None = None) -> str:
    full_env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C", **(env or {})}
    try:
        done = subprocess.run(["git", *args], cwd=str(cwd), env=full_env, input=input_bytes,
                              capture_output=True, timeout=GIT_TIMEOUT, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        raise ContextsError(f"git {args[0]} failed: {error}", 502) from error
    if done.returncode != 0:
        detail = (done.stderr or done.stdout).decode("utf-8", "replace").strip().splitlines()
        raise ContextsError(f"git {' '.join(args[:2])} failed: {detail[-1] if detail else done.returncode}", 502,
                            git_output=(done.stderr or b"").decode("utf-8", "replace")[-500:])
    return done.stdout.decode("utf-8", "replace").strip()


def _auth_env(token: str | None) -> dict:
    """The token as an HTTP header, through git's environment config — never
    in a command line or a stored remote URL."""
    if not token:
        return {}
    return {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.extraHeader",
            "GIT_CONFIG_VALUE_0": f"Authorization: token {token}"}


def _clean_path(value) -> str:
    text = str(value or "").strip().strip("/")
    pure = PurePosixPath(text)
    if not text or pure.is_absolute() or any(part in ("", ".", "..", ".git") for part in pure.parts):
        raise ContextsError(f"{text!r} is not a path inside the repository")
    return pure.as_posix()


@dataclass
class Change:
    path: str
    data: bytes | None  # None deletes


def parse_changes(files) -> list[Change]:
    if not isinstance(files, list) or not files:
        raise ContextsError("files must be a non-empty list of {path, text | base64 | delete}")
    changes: list[Change] = []
    seen: set[str] = set()
    total = 0
    for entry in files:
        if not isinstance(entry, dict):
            raise ContextsError("each file is an object")
        path = _clean_path(entry.get("path"))
        if path in seen:
            raise ContextsError(f"{path} is named twice")
        seen.add(path)
        if entry.get("delete") is True:
            changes.append(Change(path, None))
            continue
        if isinstance(entry.get("text"), str):
            data = entry["text"].encode("utf-8")
        elif isinstance(entry.get("base64"), str):
            try:
                data = base64.b64decode(entry["base64"], validate=True)
            except (binascii.Error, ValueError) as error:
                raise ContextsError(f"{path}: base64 does not decode ({error})") from error
        else:
            raise ContextsError(f"{path}: give text, base64 or delete")
        if len(data) > FILE_LIMIT:
            raise ContextsError(f"{path} is {len(data):,} bytes; the limit is {FILE_LIMIT:,}", 413)
        total += len(data)
        changes.append(Change(path, data))
    if total > PUBLISH_LIMIT:
        raise ContextsError(f"one publication carries at most {PUBLISH_LIMIT:,} bytes", 413)
    return changes


class Workspace:
    """A bare clone the relay commits in, one per repository, never checked out."""

    def __init__(self, root: Path, url: str, token: str | None) -> None:
        self.root = root
        self.url = url
        self.env = _auth_env(token)

    def fetch(self) -> None:
        if not (self.root / "HEAD").is_file():
            self.root.mkdir(parents=True, exist_ok=True)
            _git(["init", "-q", "--bare"], self.root)
        _git(["fetch", "--quiet", "--prune", "--force", self.url, "+refs/heads/*:refs/heads/*"], self.root, self.env)

    def head(self, branch: str) -> str | None:
        try:
            return _git(["rev-parse", "--verify", "--quiet", f"refs/heads/{branch}^{{commit}}"], self.root)
        except ContextsError:
            return None

    def read(self, commit: str, path: str) -> bytes | None:
        try:
            done = subprocess.run(["git", "cat-file", "blob", f"{commit}:{path}"], cwd=str(self.root),
                                  capture_output=True, timeout=GIT_TIMEOUT, check=False)
        except (OSError, subprocess.SubprocessError):
            return None
        return done.stdout if done.returncode == 0 else None

    def changed(self, old: str, new: str) -> list[str]:
        out = _git(["diff", "--name-only", old, new], self.root)
        return [line for line in out.splitlines() if line]

    def commit(self, base: str | None, changes: list[Change], message: str, author: tuple[str, str]) -> str:
        with tempfile.TemporaryDirectory(prefix="ctx-index-") as scratch:
            env = {"GIT_INDEX_FILE": str(Path(scratch) / "index")}
            if base:
                _git(["read-tree", base], self.root, env)
            else:
                _git(["read-tree", "--empty"], self.root, env)
            for change in changes:
                if change.data is None:
                    _git(["update-index", "--force-remove", "--", change.path], self.root, env)
                    continue
                blob = _git(["hash-object", "-w", "--stdin"], self.root, input_bytes=change.data)
                _git(["update-index", "--add", "--cacheinfo", f"100644,{blob},{change.path}"], self.root, env)
            tree = _git(["write-tree"], self.root, env)
        if base and tree == _git(["rev-parse", f"{base}^{{tree}}"], self.root):
            raise ContextsError("nothing changed: every file already has that content", 409, unchanged=True, head=base)
        name, email = author
        who = {"GIT_AUTHOR_NAME": name, "GIT_AUTHOR_EMAIL": email, "GIT_COMMITTER_NAME": name,
               "GIT_COMMITTER_EMAIL": email}
        args = ["commit-tree", tree, "-F", "-"] + (["-p", base] if base else [])
        return _git(args, self.root, who, input_bytes=message.encode("utf-8"))

    def push(self, commit: str, branch: str) -> bool:
        """True when the branch now points at `commit`; False when it moved (no force)."""
        try:
            _git(["push", "--quiet", "--porcelain", self.url, f"{commit}:refs/heads/{branch}"], self.root, self.env)
            return True
        except ContextsError as error:
            output = str(error.extra.get("git_output", "")) + str(error)
            if "rejected" in output or "non-fast-forward" in output or "fetch first" in output:
                return False
            raise


# --- the catalog file -------------------------------------------------------------------


CATALOG_HEADER = (
    "# Context repositories every agent can read with `agrefs` (pyagag agag.refs).\n"
    "# Managed from agdevworld's context panel; ordinary git edits are fine too.\n"
    "# id is the <source> in every reference and never changes; name and\n"
    "# description are for people and agents choosing what to read.\n"
)
ENTRY_KEYS = ("id", "name", "description", "repository", "url", "branch", "status", "registered_at")


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def render_catalog(entries: list[dict]) -> str:
    lines = [CATALOG_HEADER.rstrip("\n"), "", f'schema = "{refs.CATALOG_SCHEMA}"']
    for entry in entries:
        lines.extend(["", "[[source]]"])
        for key in ENTRY_KEYS:
            value = entry.get(key)
            if value in (None, ""):
                continue
            lines.append(f"{key} = {_toml_string(str(value))}")
    return "\n".join(lines) + "\n"


def read_catalog_entries(text: str | None) -> list[dict]:
    if not text:
        return []
    data = tomllib.loads(text)
    return [dict(entry) for entry in data.get("source", []) or [] if isinstance(entry, dict)]


# --- the service -----------------------------------------------------------------------------


def _short(sha: str | None) -> str | None:
    return sha[:7] if sha else None


class Contexts:
    """The relay's catalog read model and the Developer's write operations."""

    def __init__(self, *, home: Path = DEFAULT_HOME, config_path: Path = DEFAULT_CONFIG,
                 gitea_factory: Callable[[WriteConfig, str], Gitea] | None = None,
                 environ=None, log: Callable[[str], None] = lambda line: None,
                 clock: Callable[[], float] = time.time) -> None:
        self.home = Path(home)
        self.config_path = Path(config_path)
        self.environ = environ
        self.log = log
        self.clock = clock
        self._gitea_factory = gitea_factory or (lambda config, token: Gitea(config.api, token))
        self._heads: dict[str, tuple[float, dict]] = {}
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()

    # -- reading --------------------------------------------------------

    def _sources(self, refresh: bool | None = None):
        return refs.load_sources(self.home, refresh=refresh, environ=self.environ, with_catalog=True)

    def _source(self, ident: str) -> refs.Source:
        try:
            return refs.source_named(ident, base=self.home)
        except refs.RefsError as error:
            raise ContextsError(str(error), 404) from error

    def _head(self, source: refs.Source, refresh: bool) -> dict:
        now = self.clock()
        with self._lock:
            cached = self._heads.get(source.name)
        if cached and not refresh and now - cached[0] < HEAD_TTL_SECONDS:
            return cached[1]
        try:
            refs.fetch(source)
            sha = refs._known(source, source.head_ref)
            if sha is None:
                found = {"state": "empty", "revision": None, "short": None}
            else:
                found = {"state": "current", **self._commit_info(source, sha)}
        except refs.RefsError as error:
            sha = refs._known(source, source.head_ref)
            found = {"state": "unavailable", "error": str(error),
                     **(self._commit_info(source, sha) if sha else {"revision": None, "short": None})}
            if sha:
                found["state"] = "last-known"
        found["checked_at"] = now
        with self._lock:
            self._heads[source.name] = (now, found)
        return found

    @staticmethod
    def _commit_info(source: refs.Source, sha: str) -> dict:
        try:
            line = refs._git("log", "-1", "--format=%cI%x00%an%x00%s", sha, cwd=source.mirror).strip()
            date, author, subject = (line.split("\x00") + ["", "", ""])[:3]
        except refs.RefsError:
            date, author, subject = "", "", ""
        return {"revision": sha, "short": sha[:7], "date": date, "author": author, "subject": subject}

    def board(self, *, include_archived: bool = False, refresh: bool = False) -> dict:
        sources, found = self._sources(refresh=True if refresh else None)
        rows = []
        for source in sources:
            if source.archived and not include_archived:
                continue
            rows.append({
                "id": source.name, "name": source.title or source.name, "description": source.about,
                "status": source.status, "branch": source.branch or None, "origin": source.origin,
                "web": source.web, "head": self._head(source, refresh),
            })
        rows.sort(key=lambda row: (row["status"] != refs.ACTIVE, row["name"].lower()))
        return {
            "schema": "agdevworld.contexts.v1",
            "generated_at": self.clock(),
            "catalog": found.payload(),
            "sources": rows,
            "archived_hidden": 0 if include_archived else sum(1 for s in sources if s.archived),
            "write": self.write_status(),
        }

    def resolve(self, ident: str, revision: str | None = "latest") -> dict:
        source = self._source(ident)
        try:
            source, sha = refs.resolve(refs.Ref(source.name, revision or refs.LATEST, ""), sources=[source])
        except refs.RefsError as error:
            raise ContextsError(str(error), 404 if "no such revision" in str(error) or "empty" in str(error) else 502) from error
        with self._lock:
            self._heads.pop(source.name, None)
        return {"id": source.name, "ref": f"{source.name}@{sha}", **self._commit_info(source, sha)}

    def tree(self, ident: str, revision: str) -> dict:
        source = self._source(ident)
        try:
            found = refs.tree(refs.Ref(source.name, revision, ""), sources=[source])
            _, _, root = refs.snapshot(refs.Ref(source.name, found["revision"], ""), sources=[source])
        except refs.RefsError as error:
            raise ContextsError(str(error), 404) from error
        readme = None
        for name in ("README.md", "readme.md", "README.txt", "README"):
            candidate = root / name
            if candidate.is_file() and refs.is_text(candidate):
                text = candidate.read_text(encoding="utf-8", errors="replace")
                readme = {"path": name, "text": text[:README_LIMIT], "truncated": len(text) > README_LIMIT}
                break
        return {"id": source.name, "name": source.title or source.name, "description": source.about,
                "short": found["revision"][:7], **found, "readme": readme, **self._commit_info(source, found["revision"])}

    def file(self, ident: str, revision: str, path: str) -> tuple[bytes, str, str]:
        """(bytes, content type, resolved full sha) of one file at one revision."""
        source = self._source(ident)
        clean = _clean_path(path)
        try:
            source, sha = refs.resolve(refs.Ref(source.name, revision, ""), sources=[source])
            target = refs.path_of(refs.Ref(source.name, sha, clean), sources=[source])
        except refs.RefsError as error:
            raise ContextsError(str(error), 404) from error
        if target.is_dir():
            raise ContextsError(f"{clean} is a directory", 400)
        kind = TEXT_TYPES.get(target.suffix.lower()) or mimetypes.guess_type(target.name)[0]
        if kind is None:
            kind = "text/plain; charset=utf-8" if refs.is_text(target) else "application/octet-stream"
        return target.read_bytes(), kind, sha

    # -- writing ----------------------------------------------------------

    def _config(self) -> WriteConfig:
        return load_write_config(self.config_path)

    def write_status(self) -> dict:
        config = self._config()
        if config.error:
            return {"configured": False, "reason": config.error}
        if config.token_file is None or not config.token_file.is_file():
            return {"configured": False,
                    "reason": f"the Developer's Gitea token file is missing ({config.token_file.name if config.token_file else 'token_file'})"}
        found = refs.catalog(self.home, refresh=False, environ=self.environ)
        if not found.url:
            return {"configured": False, "reason": "no catalog is configured on this host ([catalog] url in ~/.config/agag/refs.toml)"}
        return {"configured": True, "reason": None, "owner": self._owner(config, found.url)}

    def _owner(self, config: WriteConfig, catalog_url: str) -> str:
        return config.owner or self._catalog_repo(catalog_url)[0]

    @staticmethod
    def _catalog_repo(catalog_url: str) -> tuple[str, str]:
        path = urlsplit(catalog_url).path if "://" in catalog_url else catalog_url
        segments = [one for one in path.split("/") if one]
        if len(segments) < 2:
            raise ContextsError(f"cannot read owner/name from the catalog URL {catalog_url}", 503)
        name = segments[-1][: -len(".git")] if segments[-1].endswith(".git") else segments[-1]
        return segments[-2], name

    def _writer(self):
        config = self._config()
        status = self.write_status()
        if not status["configured"]:
            raise ContextsError(status["reason"], 503)
        token = config.token_file.read_text(encoding="utf-8").strip()
        found = refs.catalog(self.home, refresh=False, environ=self.environ)
        api = config.api
        if not api:
            parts = urlsplit(found.url)
            api = f"{parts.scheme}://{parts.netloc}" if parts.scheme else None
        if not api:
            raise ContextsError("no Gitea API URL: set [gitea] url in contexts.toml", 503)
        gitea = self._gitea_factory(WriteConfig(config.token_file, api, config.owner, config.author_name,
                                                config.author_email, config.path), token)
        return config, token, found.url, gitea

    def _author(self, config: WriteConfig, gitea: Gitea) -> tuple[str, str]:
        if config.author_name and config.author_email:
            return config.author_name, config.author_email
        user = gitea.user()
        name = config.author_name or user.get("full_name") or user.get("login") or "Developer"
        email = config.author_email or user.get("email") or f"{user.get('login', 'developer')}@noreply.invalid"
        return name, email

    def _workspace(self, key: str, url: str, token: str) -> Workspace:
        return Workspace(self.home / "contexts" / "work" / f"{key}.git", url, token)

    def _record(self, entry: dict) -> None:
        path = self.home / "contexts" / "publications.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"at": self.clock(), **entry}, ensure_ascii=False) + "\n")

    def _edit_catalog(self, catalog_url: str, token: str, author: tuple[str, str], message: str,
                      edit: Callable[[list[dict]], list[dict] | None]) -> str | None:
        """Apply `edit` to the newest catalog and push it; retried on a race,
        since a structured edit re-applies cleanly. None when nothing changed."""
        workspace = self._workspace("_catalog", catalog_url, token)
        for _ in range(CATALOG_RETRIES):
            workspace.fetch()
            branch = self._catalog_branch(workspace)
            head = workspace.head(branch)
            current = workspace.read(head, refs.CATALOG_FILE) if head else None
            entries = read_catalog_entries(current.decode("utf-8") if current else None)
            changed = edit([dict(one) for one in entries])
            if changed is None:
                return None
            text = render_catalog(changed)
            refs.parse_catalog(text, catalog_url, self.home / refs.CACHE_NAME)  # never publish an unusable catalog
            try:
                commit = workspace.commit(head, [Change(refs.CATALOG_FILE, text.encode("utf-8"))],
                                          message + "\n\nPublished-from: agdevworld context panel\n", author)
            except ContextsError as error:
                if error.extra.get("unchanged"):
                    return None
                raise
            if workspace.push(commit, branch):
                refs.catalog(self.home, refresh=True, environ=self.environ)
                return commit
        raise ContextsError("the catalog kept moving while it was being edited; try again", 409)

    @staticmethod
    def _catalog_branch(workspace: Workspace) -> str:
        for candidate in ("main", "master"):
            if workspace.head(candidate):
                return candidate
        return "main"

    def _require_id(self, ident) -> str:
        ident = str(ident or "").strip()
        if not refs.NAME_RE.match(ident):
            raise ContextsError(f"{ident!r} is not an id: lower-case letters, digits, '.', '_' or '-', "
                                "starting with a letter or digit, at most 64")
        return ident

    def create(self, body: dict) -> dict:
        """A new human-owned repository with a first README commit, then its
        catalog entry. Repeating it finishes whatever an earlier attempt left."""
        ident = self._require_id(body.get("id"))
        name = str(body.get("name") or "").strip() or ident
        description = str(body.get("description") or "").strip()
        readme = body.get("readme")
        readme = readme if isinstance(readme, str) and readme.strip() else f"# {name}\n\n{description}\n"
        branch = str(body.get("branch") or "main").strip() or "main"
        with self._write_lock:
            config, token, catalog_url, gitea = self._writer()
            owner = self._owner(config, catalog_url)
            sources, _ = self._sources(refresh=True)
            existing = next((s for s in sources if s.name == ident), None)
            if existing is not None and existing.origin == "catalog":
                expected, _ = refs.repository_url(catalog_url, f"{owner}/{ident}")
                if existing.url != expected:
                    raise ContextsError(f"{ident} is already registered for {existing.url}", 409)
            steps: list[str] = []
            repo = gitea.repo(owner, ident)
            if repo is None:
                repo = gitea.create_repo(ident, description, branch)
                steps.append("repository created")
            else:
                steps.append("repository already existed")
            url, web = refs.repository_url(catalog_url, f"{owner}/{ident}")
            author = self._author(config, gitea)
            workspace = self._workspace(ident, url, token)
            workspace.fetch()
            head = workspace.head(branch)
            if head is None:
                commit = workspace.commit(None, [Change("README.md", readme.encode("utf-8"))],
                                          f"Create {name}\n\nPublished-from: agdevworld context panel\n", author)
                if not workspace.push(commit, branch):
                    workspace.fetch()
                    head = workspace.head(branch)
                    if head is None:
                        raise ContextsError("the first publication was refused", 502)
                    steps.append("first publication already made elsewhere")
                else:
                    head = commit
                    steps.append("README published")
                    self._record({"action": "create", "id": ident, "revision": commit, "files": ["README.md"]})
            else:
                steps.append("first publication already made")

            def register(entries: list[dict]) -> list[dict] | None:
                if any(entry.get("id") == ident for entry in entries):
                    return None
                entries.append({"id": ident, "name": name, "description": description,
                                "repository": f"{owner}/{ident}", "branch": branch, "status": refs.ACTIVE,
                                "registered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.clock()))})
                return entries

            registered = self._edit_catalog(catalog_url, token, author, f"Register {ident}", register)
            steps.append("registered in the catalog" if registered else "already registered")
            if registered:
                self._record({"action": "register", "id": ident, "catalog": registered})
            self.log(f"contexts: create {ident}: {', '.join(steps)}")
            return {"id": ident, "revision": head, "short": head[:7], "ref": f"{ident}@{head}", "web": web,
                    "steps": steps, "catalog_revision": registered}

    def register(self, body: dict) -> dict:
        """An existing repository (with at least one commit) into the catalog."""
        ident = self._require_id(body.get("id"))
        repository = str(body.get("repository") or "").strip().strip("/")
        url = str(body.get("url") or "").strip()
        if not repository and not url:
            raise ContextsError("give repository (owner/name on this Gitea) or url")
        name = str(body.get("name") or "").strip() or ident
        description = str(body.get("description") or "").strip()
        branch = str(body.get("branch") or "").strip()
        with self._write_lock:
            config, token, catalog_url, gitea = self._writer()
            target = url or refs.repository_url(catalog_url, repository)[0]
            probe = refs.Source(ident, target, description, self.home / refs.CACHE_NAME / ident, branch=branch)
            try:
                head = refs.remote_head(probe)
            except refs.RefsError as error:
                raise ContextsError(f"{target} cannot be read: {error}", 400) from error
            if head is None:
                raise ContextsError(f"{target} has no commit on {branch or 'its default branch'} yet; publish once first",
                                    409)

            def add(entries: list[dict]) -> list[dict] | None:
                for entry in entries:
                    if entry.get("id") == ident:
                        same = entry.get("repository") == repository if repository else entry.get("url") == url
                        if same:
                            return None
                        raise ContextsError(f"{ident} is already registered for another repository", 409)
                entry = {"id": ident, "name": name, "description": description, "branch": branch,
                         "status": refs.ACTIVE,
                         "registered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.clock()))}
                entry["repository" if repository else "url"] = repository or url
                entries.append(entry)
                return entries

            author = self._author(config, gitea)
            registered = self._edit_catalog(catalog_url, token, author, f"Register {ident}", add)
            if registered:
                self._record({"action": "register", "id": ident, "catalog": registered, "existing": target})
            return {"id": ident, "revision": head, "short": head[:7], "ref": f"{ident}@{head}",
                    "catalog_revision": registered, "already": registered is None}

    def update(self, ident: str, body: dict) -> dict:
        """Display name, description or status (archive/reactivate) of one entry."""
        ident = self._require_id(ident)
        fields = {}
        for key in ("name", "description"):
            if key in body:
                if not isinstance(body[key], str):
                    raise ContextsError(f"{key} must be a string")
                fields[key] = body[key].strip()
        if "status" in body:
            if body["status"] not in refs.STATUSES:
                raise ContextsError(f"status is one of {', '.join(refs.STATUSES)}")
            fields["status"] = body["status"]
        if not fields:
            raise ContextsError("nothing to change: name, description or status")
        with self._write_lock:
            config, token, catalog_url, gitea = self._writer()
            found: dict = {}

            def change(entries: list[dict]) -> list[dict] | None:
                for entry in entries:
                    if entry.get("id") == ident:
                        before = {key: entry.get(key, "") for key in fields}
                        if all((before[key] or "") == value for key, value in fields.items()):
                            return None
                        entry.update(fields)
                        found.update(entry)
                        return entries
                raise ContextsError(f"{ident} is not in the catalog", 404)

            author = self._author(config, gitea)
            commit = self._edit_catalog(catalog_url, token, author, f"Update {ident}: {', '.join(sorted(fields))}", change)
            owner = self._owner(config, catalog_url)
            if commit and "description" in fields and found.get("repository") == f"{owner}/{ident}":
                try:
                    gitea.set_description(owner, ident, fields["description"])
                except ContextsError as error:
                    self.log(f"contexts: description of {owner}/{ident} not mirrored to Gitea: {error}")
            if commit:
                self._record({"action": "update", "id": ident, "fields": fields, "catalog": commit})
            return {"id": ident, "catalog_revision": commit, "changed": commit is not None, **fields}

    def publish(self, ident: str, body: dict) -> dict:
        """Commit files on the base revision the editor loaded, or refuse with
        what moved. `force_base` is how the editor, having seen the conflict,
        publishes on top of the newer revision on purpose."""
        ident = self._require_id(ident)
        changes = parse_changes(body.get("files"))
        base = str(body.get("base") or "").strip()
        if not refs.SHA_RE.match(base):
            raise ContextsError("base must be the full commit the editor loaded")
        message = str(body.get("message") or "").strip() or f"Update {', '.join(c.path for c in changes)[:120]}"
        source = self._source(ident)
        with self._write_lock:
            config, token, catalog_url, gitea = self._writer()
            branch = source.branch or "main"
            workspace = self._workspace(ident, source.url, token)
            workspace.fetch()
            head = workspace.head(branch)
            if head is None:
                raise ContextsError(f"{ident} has no {branch} branch to publish on", 409)
            if head != base:
                known = self._is_commit(workspace, base)
                moved = workspace.changed(base, head) if known else []
                touched = sorted({c.path for c in changes} & set(moved))
                raise ContextsError(
                    f"{ident} has a newer publication ({head[:7]}) than the one you edited ({base[:7]})", 409,
                    conflict=True, head=head, short=head[:7], base=base, changed=moved, touched=touched,
                )
            author = self._author(config, gitea)
            commit = workspace.commit(base, changes, message + "\n\nPublished-from: agdevworld context panel\n", author)
            if not workspace.push(commit, branch):
                workspace.fetch()
                newer = workspace.head(branch)
                raise ContextsError(f"{ident} moved while publishing ({(newer or '')[:7]})", 409, conflict=True,
                                    head=newer, short=_short(newer), base=base,
                                    changed=workspace.changed(base, newer) if newer else [], touched=[])
            files = [c.path for c in changes]
            self._record({"action": "publish", "id": ident, "base": base, "revision": commit, "files": files,
                          "message": message})
            with self._lock:
                self._heads.pop(ident, None)
            self.log(f"contexts: published {ident}@{commit[:7]} ({len(files)} file(s))")
            return {"id": ident, "revision": commit, "short": commit[:7], "ref": f"{ident}@{commit}",
                    "base": base, "files": files}

    @staticmethod
    def _is_commit(workspace: Workspace, sha: str) -> bool:
        try:
            _git(["cat-file", "-e", f"{sha}^{{commit}}"], workspace.root)
            return True
        except ContextsError:
            return False


def contexts_from_env(log: Callable[[str], None] = lambda line: None) -> Contexts:
    config = os.environ.get(CONFIG_VARIABLE, "")
    home = os.environ.get(refs.HOME_VARIABLE, "")
    return Contexts(home=Path(home).expanduser() if home else DEFAULT_HOME,
                    config_path=Path(config).expanduser() if config else DEFAULT_CONFIG, log=log)


# --- setting up the catalog ----------------------------------------------------------


def import_entries(config: Path, catalog_url: str) -> list[dict]:
    """Catalog entries for the `[[source]]` registrations in an agent's
    `refs.toml`: a source on the catalog's own host becomes `owner/name`."""
    data = tomllib.loads(config.read_text(encoding="utf-8"))
    parts = urlsplit(catalog_url)
    host_prefix = f"{parts.scheme}://{parts.netloc}/" if parts.scheme else None
    entries = []
    for source in data.get("source", []) or []:
        url = str(source.get("url", "")).strip()
        entry = {"id": str(source.get("name", "")).strip(), "name": str(source.get("title", "")).strip(),
                 "description": str(source.get("about", "")).strip(), "branch": str(source.get("branch", "")).strip(),
                 "status": refs.ACTIVE,
                 "registered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        if host_prefix and url.startswith(host_prefix):
            repository = url[len(host_prefix):]
            entry["repository"] = repository[: -len(".git")] if repository.endswith(".git") else repository
        else:
            entry["url"] = url
        entries.append(entry)
    return entries


def init_catalog(contexts: Contexts, imports: list[Path]) -> dict:
    """Create the catalog repository named by the host's `[catalog] url` (if
    it does not exist) and add the imported registrations it lacks. Safe to
    repeat."""
    with contexts._write_lock:
        config, token, catalog_url, gitea = contexts._writer()
        owner, name = contexts._catalog_repo(catalog_url)
        steps = []
        if gitea.repo(owner, name) is None:
            gitea.create_repo(name, "The list of context repositories every agent can read (agrefs catalog)", "main")
            steps.append(f"created {owner}/{name}")
        wanted: list[dict] = []
        for path in imports:
            wanted.extend(import_entries(path, catalog_url))

        def merge(entries: list[dict]) -> list[dict] | None:
            known = {entry.get("id") for entry in entries}
            added = [entry for entry in wanted if entry["id"] not in known]
            if not added and entries:
                return None
            return entries + added

        author = contexts._author(config, gitea)
        commit = contexts._edit_catalog(catalog_url, token, author, "Catalog of context repositories", merge)
        steps.append(f"catalog at {commit[:7]}" if commit else "catalog already had every imported entry")
        return {"catalog": catalog_url, "steps": steps, "revision": commit}


CLI_USAGE = """usage: agentroom-contexts <command>

  status                  the host catalog, its state, and whether the relay can write
  init [--import FILE…]   create the catalog repository if missing and add the
                          [[source]] registrations of the named refs.toml files

The catalog URL is the host's ([catalog] url in ~/.config/agag/refs.toml); writes
use the Developer's Gitea token named by agdevworld/.local/contexts.toml
(contexts.example.toml beside agdevworld's package.json shows the shape)."""


def main(argv: list[str] | None = None) -> int:
    import sys

    argv = list(sys.argv[1:] if argv is None else argv)
    contexts = contexts_from_env(log=lambda line: print(line, file=sys.stderr))
    command = argv[0] if argv else "status"
    try:
        if command == "status":
            board = contexts.board(include_archived=True)
            catalog = board["catalog"]
            print(f"catalog: {catalog['state']} {catalog['url'] or ''} {(catalog['revision'] or '')[:7]}")
            if catalog["error"]:
                print(f"  error: {catalog['error']}")
            for issue in catalog["issues"]:
                print(f"  issue: {issue}")
            write = board["write"]
            print("write: " + ("ready as " + write["owner"] if write["configured"] else f"off — {write['reason']}"))
            for row in board["sources"]:
                head = row["head"]
                print(f"  {row['id']:<24} {row['status']:<8} {head.get('short') or '-':<8} {head['state']:<11} {row['name']}")
            return 0
        if command == "init":
            imports = [Path(one).expanduser() for one in argv[1:] if one != "--import"]
            print(json.dumps(init_catalog(contexts, imports), indent=2))
            return 0
    except ContextsError as error:
        print(f"agentroom-contexts: {error}", file=sys.stderr)
        return 1
    print(CLI_USAGE, file=sys.stderr)
    return 2
