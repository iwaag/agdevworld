"""The remembered plan (`better_zulip_call` p1 step 4), over a mirrored chain.

What is pinned: a preview is walked once and reused by the close; the
scoped channels are read from Zulip once each before the writes and nothing
else is; a child added after the preview — with no event delivered — is
found by that read and refuses the stale approval; a changed work state
does the same; a partial failure is reported per target and the retry
finishes what is left without repeating what worked; and a channel growing
elsewhere costs the close nothing.
"""

from __future__ import annotations

import time

from agag.mirror.testing import FakeRealm
from agag.zulip import RateLimited
from conftest import mirror_over

from agentroom.close import ALREADY, APPLIED, BLOCKED, DONE, FAILED, KEPT, READY, SKIPPED, Closer
from agentroom.realm import MirrorRealm

DEVELOPER, FRONT_BOT, AUTOLAB_BOT = 8, 15, 11
ROOT = ("front", "front-desk-1")


def selfnote(realm, channel, topic, tag, value, *, sender_id=AUTOLAB_BOT, sender="autolab", quiet=True):
    return realm.post(channel, topic, f"[selfnote][{tag}] {value}", sender_id=sender_id, sender_name=sender,
                      quiet=quiet)


class Writer:
    """The Developer's credential over the fake realm: every write is a
    real change in the realm, which the mirror learns of through its queue."""

    def __init__(self, realm: FakeRealm, fail: set | None = None):
        self.realm, self.fail = realm, set(fail or ())
        self.resolved, self.archived, self.posted = [], [], []

    def _channel_of(self, stream_id):
        return self.realm.channels_by_id[int(stream_id)]["name"]

    def stream_id(self, name):
        for row in self.realm.channels_by_id.values():
            if row["name"] == name and not row["is_archived"]:
                return row["stream_id"]
        raise LookupError(name)

    def channel_topics(self, stream_id):
        return [row["name"] for row in self.realm.channel_topics_detail(int(stream_id))]

    def resolve_topic(self, message_id, topic):
        if ("topic", topic) in self.fail:
            raise ConnectionError("realm refused the rename")
        channel = self._channel_of(self.realm.messages[int(message_id)]["stream_id"])
        self.resolved.append((channel, topic))
        self.realm.resolve(channel, topic)

    def archive_channel(self, stream_id):
        name = self._channel_of(stream_id)
        if ("channel", name) in self.fail:
            raise ConnectionError("realm refused the archive")
        self.archived.append(name)
        self.realm.archive(int(stream_id))

    def send_to_channel(self, channel, topic, content):
        self.posted.append((channel, topic, content))
        return self.realm.post(channel, topic, content, sender_id=DEVELOPER, sender_name="Developer")


def chain():
    """A Front Desk request delegated to autolab: a mission in `pj-x` with
    one finished task in its dedicated `work-m<id>` channel."""
    realm = FakeRealm()
    realm.add_channel(35, "agents")
    realm.add_channel(5, "front")
    realm.add_channel(6, "pj-x")
    realm.post("front", "front-desk-1", "Please cover a new trending repo.", sender_id=DEVELOPER,
               sender_name="Developer", quiet=True)
    mission = selfnote(realm, "pj-x", "workplan-a", "mission", "x")
    selfnote(realm, "pj-x", "workplan-a", "rootchat", "front/front-desk-1")
    plan_post = realm.post("pj-x", "workplan-a", "# One task\n\nSummarize.", sender_id=AUTOLAB_BOT, sender_name="autolab", quiet=True)
    selfnote(realm, "pj-x", "workplan-a", "doc", str(plan_post))
    selfnote(realm, "pj-x", "workplan-a", "state", "started")
    work = f"work-m{mission}"
    realm.add_channel(7, work)
    task_topic = f"workrun-task1-m{mission}"
    selfnote(realm, work, task_topic, "task", f"{mission}#1")
    selfnote(realm, work, task_topic, "rootchat", "pj-x/workplan-a")
    realm.post(work, task_topic, "# Summarize\n\nbody", sender_id=AUTOLAB_BOT, sender_name="autolab", quiet=True)
    selfnote(realm, work, task_topic, "state", "completed")
    realm.resolve(work, task_topic, quiet=True)
    selfnote(realm, "front", "front-desk-1", "served", f"pj-x/workplan-a {plan_post}", sender_id=FRONT_BOT, sender="Front")
    realm.post("front", "front-desk-1", "Done — the summary is written up.", sender_id=FRONT_BOT, sender_name="Front", quiet=True)
    return realm, mission, work, task_topic


def door_over(realm, fail=None):
    mirror = mirror_over(realm)
    mirror.start()  # the ingest thread carries the writer's changes back
    writer = Writer(realm, fail)
    door = Closer(topics=lambda: {}, reader_factory=lambda: MirrorRealm(mirror),
                  writer_factory=lambda: writer, mirror=mirror, confirm_seconds=3.0)
    return door, writer, mirror


def by_key(payload):
    return {a["key"]: a["state"] for a in payload["actions"]}


def outcomes(payload):
    return {r["key"]: r["outcome"] for r in payload["results"]}


def asked(mirror) -> int:
    """Zulip calls the mirror made *for questions*: hydrations, verifies,
    listing refreshes — never its own polling (in these tests the fake realm
    is both the poller and the reader, so a raw count would mix them)."""
    ledger = mirror.health()["ledger"]
    return sum(n for key, n in ledger.items() if key.split(" ", 1)[0] in ("hydrate", "verify"))


def test_the_preview_is_walked_once_and_the_close_reuses_it():
    realm, mission, work, task_topic = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    assert door.discoveries == 1 and plan["gaps"]["zulip_calls"] == 0
    assert by_key(plan) == {f"work:m{mission}": READY, "topic:pj-x/workplan-a": READY,
                            f"topic:{work}/{task_topic}": DONE, f"channel:{work}": READY,
                            "topic:front/front-desk-1": READY}
    assert plan["depends_on"]["channels"] == ["front", "pj-x", work]
    assert door.plan(ROOT)["fingerprint"] == plan["fingerprint"] and door.discoveries == 1
    calls = asked(mirror)
    closed = door.close(ROOT, plan["fingerprint"])
    assert door.discoveries == 1, "the close reused the preview's walk"
    assert closed["revalidated"]["channels"] == ["front", "pj-x", work]
    assert closed["revalidated"]["changed"] == [] and closed["revalidated"]["zulip_calls"] == 3
    assert asked(mirror) - calls == 3, "one listing per scoped channel, nothing else"
    assert outcomes(closed) == {f"work:m{mission}": APPLIED, "topic:pj-x/workplan-a": APPLIED,
                                f"topic:{work}/{task_topic}": ALREADY, f"channel:{work}": APPLIED,
                                "topic:front/front-desk-1": APPLIED}
    assert all(r["confirmed"] for r in closed["results"] if r["outcome"] == APPLIED)
    assert not closed["partial"] and closed["applied"]
    assert by_key(closed)[f"channel:{work}"] == DONE and by_key(closed)["topic:front/front-desk-1"] == DONE
    assert writer.resolved == [("pj-x", "workplan-a"), ("front", "front-desk-1")] and writer.archived == [work]
    assert [c for _, _, c in writer.posted] == ["[selfnote][state] accepted", "[selfnote][state] done"]
    # A second preview reads the copy, which carries the writes: everything is done.
    after = door.plan(ROOT)
    assert set(by_key(after).values()) == {DONE} and after["gaps"]["zulip_calls"] == 0
    mirror.stop()


def test_a_child_added_after_the_preview_is_found_before_anything_is_written():
    realm, mission, work, task_topic = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    # Event lag: autolab opens a second task and no event has arrived.
    second = f"workrun-task2-m{mission}"
    selfnote(realm, work, second, "task", f"{mission}#2")
    selfnote(realm, work, second, "rootchat", "pj-x/workplan-a")
    realm.post(work, second, "# Another\n\nbody", sender_id=AUTOLAB_BOT, sender_name="autolab", quiet=True)
    time.sleep(0.3)
    assert mirror.topic(work, second) == [], "the mirror has not heard of it"
    refused = door.close(ROOT, plan["fingerprint"])
    assert refused["refused"] is True and writer.resolved == [] and writer.archived == [] and writer.posted == []
    assert f"{work}/{second}" in refused["revalidated"]["changed"]
    assert by_key(refused)[f"work:m{mission}"] == BLOCKED
    # The new task's topic is held open by its blocked mission.
    assert by_key(refused)[f"topic:{work}/{second}"] == KEPT
    assert by_key(refused)["topic:front/front-desk-1"] == READY
    assert door.discoveries == 2
    mirror.stop()


def test_a_changed_work_state_refuses_the_stale_approval():
    realm, mission, work, task_topic = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    assert by_key(plan)[f"work:m{mission}"] == READY
    # The task is re-opened, quietly: the newest state note wins.
    selfnote(realm, work, f"✔ {task_topic}", "state", "open")
    refused = door.close(ROOT, plan["fingerprint"])
    assert refused["refused"] is True and writer.posted == []
    assert by_key(refused)[f"work:m{mission}"] == BLOCKED
    assert f"{work}/✔ {task_topic}" in refused["revalidated"]["changed"]
    mirror.stop()


def test_an_edit_already_received_by_the_mirror_refuses_the_stale_approval():
    realm, mission, work, task_topic = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    assert by_key(plan)[f"work:m{mission}"] == READY
    state_id = next(
        ident for ident, message in realm.messages.items()
        if message["display_recipient"] == work
        and message["subject"] == f"✔ {task_topic}"
        and message["content"] == "[selfnote][state] completed"
    )
    revision = mirror.revision()
    realm.edit(state_id, "[selfnote][state] open")
    mirror.wait(revision, timeout=3.0)
    assert mirror.message(state_id).content == "[selfnote][state] open"

    refused = door.close(ROOT, plan["fingerprint"])

    assert refused["refused"] is True
    assert by_key(refused)[f"work:m{mission}"] == BLOCKED
    assert writer.resolved == [] and writer.archived == [] and writer.posted == []
    mirror.stop()


def test_deleting_an_older_state_note_invalidates_evidence_without_moving_the_topic_maximum():
    realm, mission, work, task_topic = chain()
    realm.post(work, f"✔ {task_topic}", "[selfnote][evidence] retained-later-message", quiet=True)
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    state_id = next(
        ident for ident, message in realm.messages.items()
        if message["display_recipient"] == work
        and message["subject"] == f"✔ {task_topic}"
        and message["content"] == "[selfnote][state] completed"
    )
    maximum = mirror.topic(work, task_topic)[0].max_id
    revision = mirror.revision()

    realm.delete(state_id)
    mirror.wait(revision, timeout=3.0)

    assert mirror.message(state_id) is None
    assert mirror.topic(work, task_topic)[0].max_id == maximum
    refused = door.close(ROOT, plan["fingerprint"])
    assert refused["refused"] is True
    assert by_key(refused)[f"work:m{mission}"] == BLOCKED
    assert writer.resolved == [] and writer.archived == [] and writer.posted == []
    mirror.stop()


def test_an_edit_in_an_unrelated_conversation_keeps_the_remembered_discovery():
    realm, _, _, _ = chain()
    realm.add_channel(9, "pj-other")
    older = realm.post("pj-other", "workplan-other", "old", quiet=True)
    realm.post("pj-other", "workplan-other", "newer", quiet=True)
    door, _, mirror = door_over(realm)
    plan = door.plan(ROOT)
    revision = mirror.revision()

    realm.edit(older, "harmless edit elsewhere")
    mirror.wait(revision, timeout=3.0)
    closed = door.close(ROOT, plan["fingerprint"])

    assert not closed.get("refused")
    assert door.discoveries == 1
    mirror.stop()


def test_lost_change_feed_coverage_rebuilds_the_discovery():
    realm, _, _, _ = chain()
    realm.add_channel(9, "pj-other")
    first = realm.post("pj-other", "workplan-other", "first", quiet=True)
    second = realm.post("pj-other", "workplan-other", "second", quiet=True)
    door, _, mirror = door_over(realm)
    plan = door.plan(ROOT)
    revision = mirror.revision()

    realm.edit(first, "first edited")
    realm.edit(second, "second edited")
    mirror.wait(revision, timeout=3.0)
    mirror.store.prune_changes(keep=1)

    again = door.plan(ROOT)
    assert again["fingerprint"] == plan["fingerprint"]
    assert door.discoveries == 2
    mirror.stop()


def test_an_edit_in_an_excluded_conversation_invalidates_its_evidence():
    realm, _, _, _ = chain()
    other = realm.post("front", "front-desk-other", "another request", quiet=True)
    selfnote(
        realm, "front", "front-desk-1", "served", f"front/front-desk-other {other}",
        sender_id=FRONT_BOT, sender="Front",
    )
    door, _, mirror = door_over(realm)
    plan = door.plan(ROOT)
    assert any(row["topic"] == "front-desk-other" for row in plan["excluded"])
    revision = mirror.revision()

    realm.edit(other, "another request, edited")
    mirror.wait(revision, timeout=3.0)
    again = door.plan(ROOT)

    assert again["fingerprint"] == plan["fingerprint"]
    assert door.discoveries == 2
    mirror.stop()


def test_a_failed_pre_write_listing_leaves_completion_unapplied(monkeypatch):
    realm, _, _, _ = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)

    def unreadable(_channel):
        raise ConnectionError("the scoped listing is unavailable")

    monkeypatch.setattr(mirror, "refresh_listing", unreadable)
    failed = door.close(ROOT, plan["fingerprint"])

    assert failed["verification_failed"] is True
    assert failed["applied"] is False
    assert failed["revalidated"]["ok"] is False
    assert [row["channel"] for row in failed["revalidated"]["failures"]] == failed["revalidated"]["channels"]
    assert writer.resolved == [] and writer.archived == [] and writer.posted == []
    mirror.stop()


def test_one_failed_scoped_listing_stops_every_completion_write(monkeypatch):
    realm, _, _, _ = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    refresh = mirror.refresh_listing

    def one_unreadable(channel):
        if channel == "pj-x":
            raise ConnectionError("only this channel is unavailable")
        return refresh(channel)

    monkeypatch.setattr(mirror, "refresh_listing", one_unreadable)
    failed = door.close(ROOT, plan["fingerprint"])

    assert failed["verification_failed"] is True
    assert failed["revalidated"]["failures"] == [
        {"channel": "pj-x", "reason": "ConnectionError: only this channel is unavailable"}
    ]
    assert writer.resolved == [] and writer.archived == [] and writer.posted == []
    mirror.stop()


def test_a_rate_limit_is_a_retryable_verification_failure(monkeypatch):
    realm, _, _, _ = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    monkeypatch.setattr(
        mirror, "refresh_listing",
        lambda _channel: (_ for _ in ()).throw(RateLimited("quota paused", retry_after=1)),
    )

    failed = door.close(ROOT, plan["fingerprint"])

    assert failed["verification_failed"] is True and failed["retryable"] is True
    assert all(row["reason"].startswith("RateLimited:") for row in failed["revalidated"]["failures"])
    assert writer.resolved == [] and writer.archived == [] and writer.posted == []
    mirror.stop()


def test_retry_after_verification_recovers_and_completes(monkeypatch):
    realm, _, _, _ = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    refresh = mirror.refresh_listing
    monkeypatch.setattr(
        mirror, "refresh_listing",
        lambda _channel: (_ for _ in ()).throw(ConnectionError("temporary outage")),
    )
    failed = door.close(ROOT, plan["fingerprint"])
    assert failed["verification_failed"] is True and writer.posted == []

    monkeypatch.setattr(mirror, "refresh_listing", refresh)
    closed = door.close(ROOT, plan["fingerprint"])

    assert closed["applied"] is True and not closed.get("refused")
    assert closed["revalidated"]["ok"] is True
    assert not closed["partial"]
    mirror.stop()


def test_retry_refuses_old_approval_when_work_changed_during_failed_verification(monkeypatch):
    realm, mission, work, task_topic = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    refresh = mirror.refresh_listing
    monkeypatch.setattr(
        mirror, "refresh_listing",
        lambda _channel: (_ for _ in ()).throw(ConnectionError("temporary outage")),
    )
    failed = door.close(ROOT, plan["fingerprint"])
    assert failed["verification_failed"] is True

    selfnote(realm, work, f"✔ {task_topic}", "state", "open")
    monkeypatch.setattr(mirror, "refresh_listing", refresh)
    refused = door.close(ROOT, plan["fingerprint"])

    assert refused["refused"] is True
    assert by_key(refused)[f"work:m{mission}"] == BLOCKED
    assert writer.resolved == [] and writer.archived == [] and writer.posted == []
    mirror.stop()


def test_a_partial_failure_is_reported_per_target_and_the_retry_finishes_it():
    realm, mission, work, task_topic = chain()
    door, writer, mirror = door_over(realm, fail={("channel", work)})
    plan = door.plan(ROOT)
    closed = door.close(ROOT, plan["fingerprint"])
    assert outcomes(closed) == {f"work:m{mission}": APPLIED, "topic:pj-x/workplan-a": APPLIED,
                                f"topic:{work}/{task_topic}": ALREADY, f"channel:{work}": FAILED,
                                "topic:front/front-desk-1": SKIPPED}
    assert closed["partial"] is True
    shown = by_key(closed)
    assert shown[f"work:m{mission}"] == DONE and shown[f"channel:{work}"] == READY
    assert shown["topic:front/front-desk-1"] == READY
    assert "failed" in next(a["reason"] for a in closed["actions"] if a["key"] == f"channel:{work}")
    # The retry approves the post-write plan; the realm now accepts the archive.
    writer.fail.clear()
    again = door.close(ROOT, closed["fingerprint"])
    assert not again.get("refused"), again.get("error")
    assert outcomes(again) == {f"work:m{mission}": ALREADY, "topic:pj-x/workplan-a": ALREADY,
                               f"topic:{work}/{task_topic}": ALREADY, f"channel:{work}": APPLIED,
                               "topic:front/front-desk-1": APPLIED}
    assert [c for _, _, c in writer.posted] == ["[selfnote][state] accepted", "[selfnote][state] done"], \
        "the acceptance was written once"
    assert not again["partial"] and writer.archived == [work]
    mirror.stop()


def test_growth_elsewhere_costs_the_close_nothing():
    realm, mission, work, task_topic = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    realm.create_channel(9, "pj-other")
    for n in range(5):
        realm.post("pj-other", f"workplan-{n}", "busy elsewhere", sender_id=AUTOLAB_BOT, sender_name="autolab")
    time.sleep(0.4)
    assert mirror.channel("pj-other") is not None
    closed = door.close(ROOT, plan["fingerprint"])
    assert not closed.get("refused") and closed["revalidated"]["channels"] == ["front", "pj-x", work]
    assert closed["revalidated"]["zulip_calls"] == 3, closed["revalidated"]
    assert door.discoveries == 1
    # Two more polls at most in the window; no listing of `pj-other`.
    ledger = mirror.health()["ledger"]
    assert ledger.get("verify GET topics", 0) == 3
    mirror.stop()
