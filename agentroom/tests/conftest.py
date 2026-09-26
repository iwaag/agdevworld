"""Shared fixtures: a mirror over `agag.mirror.testing.FakeRealm`.

Since `better_zulip_call` p1 every read the relay makes comes from its
mirror, so a test that wants a realm builds a `FakeRealm`, mirrors it, and
reads the boards off that. `mirror_over(realm)` fills the mirror
synchronously (no ingest thread) so a test sees the realm as it stands;
`realm.post(...)` afterwards is delivered by `pump(mirror)`, which applies
whatever the fake queue holds — the event path, without waiting on a thread.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from agag.mirror import Mirror
from agag.mirror.store import Store
from agag.mirror.testing import FakeRealm

__all__ = ["FakeRealm", "empty_room", "mirror_over", "pump"]


def mirror_over(realm: FakeRealm | None = None) -> Mirror:
    """A live, filled mirror of `realm` with no thread behind it."""
    realm = realm if realm is not None else FakeRealm()
    store = Store(Path(tempfile.mkdtemp(prefix="agentroom-mirror-")) / "mirror.sqlite")
    mirror = Mirror(store, realm.facet, log=lambda line: None)
    client = mirror._client()
    mirror._self = dict(client.whoami())
    queue_id, last = client.register(list(__import__("agag.mirror", fromlist=["EVENT_TYPES"]).EVENT_TYPES),
                                     all_public_streams=True, fetch_event_types=[])
    mirror._resync(client)
    with mirror.store.transaction():
        mirror.store.set_checkpoint(queue_id, last)
    mirror._set_live("live")
    mirror.realm = realm  # type: ignore[attr-defined]
    return mirror


def pump(mirror: Mirror) -> int:
    """Apply every event the fake realm has queued since the checkpoint."""
    client = mirror._client()
    queue_id, last = mirror.store.checkpoint()
    events = client.poll(queue_id, last, dont_block=True)
    mirror._apply_batch(queue_id, last, events)
    return len(events)


def empty_room():
    from agentroom.room import Room

    return Room(mirror=mirror_over(FakeRealm()))


import pytest as _pytest


@_pytest.fixture(autouse=True)
def _no_host_refs_config(tmp_path_factory, monkeypatch):
    """The developer's own `~/.config/agag/refs.toml` never reaches a test."""
    monkeypatch.setenv("AGREFS_HOST_CONFIG", str(tmp_path_factory.mktemp("hostcfg") / "refs.toml"))
    monkeypatch.delenv("AGREFS_CATALOG", raising=False)
