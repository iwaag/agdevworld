"""The remembered plan (`better_zulip_call` p1 step 4), over a mirrored chain.

What is pinned: a preview is walked once and reused by the close; the
scoped channels are read from Zulip once each before the writes and nothing
else is; a child added after the preview — with no event delivered — is
found by that read and refuses the stale approval; a related topic resolved
or re-anchored since the preview does the same; a partial failure is
reported per target and the retry finishes what is left without repeating
what worked; and a channel growing elsewhere costs the close nothing.
"""

from __future__ import annotations

import time

from agag.mirror.testing import FakeRealm
from agag.zulip import RateLimited
from conftest import mirror_over

from agentroom.close import ALREADY, APPLIED, DONE, FAILED, READY, SKIPPED, Closer
from agentroom.realm import MirrorRealm

DEVELOPER, FRONT_BOT, AGENT_BOT, TOOL_BOT = 8, 15, 11, 12
ROOT = ("front", "front-desk-1")
AGENT = "agecho-agstudio1"
PLAN = "agechoplan-a"
TOOL = "agtool-agstudio1"
CHILD = "toolrun-a"


def selfnote(realm, channel, topic, tag, value, *, sender_id=AGENT_BOT, sender="agecho", quiet=True):
    return realm.post(channel, topic, f"[selfnote][{tag}] {value}", sender_id=sender_id, sender_name=sender,
                      quiet=quiet)


class Writer:
    """The Developer's credential over the fake realm: every write is a
    real change in the realm, which the mirror learns of through its queue."""

    def __init__(self, realm: FakeRealm, fail: set | None = None):
        self.realm, self.fail = realm, set(fail or ())
        self.resolved, self.posted = [], []

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

    def send_to_channel(self, channel, topic, content):
        self.posted.append((channel, topic, content))
        return self.realm.post(channel, topic, content, sender_id=DEVELOPER, sender_name="Developer")


def chain():
    """A Front Desk request delegated to an agent, which delegated a step
    to a tool agent whose run is already ✔."""
    realm = FakeRealm()
    realm.add_channel(35, "agents")
    realm.add_channel(5, "front")
    realm.add_channel(6, AGENT)
    realm.add_channel(7, TOOL)
    realm.post("front", "front-desk-1", "Please cover a new trending repo.", sender_id=DEVELOPER,
               sender_name="Developer", quiet=True)
    selfnote(realm, AGENT, PLAN, "rootchat", "front/front-desk-1")
    plan_post = realm.post(AGENT, PLAN, "# One step\n\nSummarize.", sender_id=AGENT_BOT,
                           sender_name="agecho", quiet=True)
    selfnote(realm, TOOL, CHILD, "rootchat", f"{AGENT}/{PLAN}", sender_id=TOOL_BOT, sender="agtool")
    child_post = realm.post(TOOL, CHILD, "summary written", sender_id=TOOL_BOT, sender_name="agtool",
                            quiet=True)
    realm.resolve(TOOL, CHILD, quiet=True)
    selfnote(realm, AGENT, PLAN, "served", f"{TOOL}/{CHILD} {child_post}")
    realm.post(AGENT, PLAN, "Step done.", sender_id=AGENT_BOT, sender_name="agecho", quiet=True)
    selfnote(realm, "front", "front-desk-1", "served", f"{AGENT}/{PLAN} {plan_post}",
             sender_id=FRONT_BOT, sender="Front")
    realm.post("front", "front-desk-1", "Done — the summary is written up.", sender_id=FRONT_BOT,
               sender_name="Front", quiet=True)
    return realm


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


def message_id(realm, channel, topic, content):
    return next(ident for ident, message in realm.messages.items()
                if message["display_recipient"] == channel and message["subject"] == topic
                and message["content"] == content)


SCOPED = sorted(["front", AGENT, TOOL])


def test_the_preview_is_walked_once_and_the_close_reuses_it():
    realm = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    assert door.discoveries == 1 and plan["gaps"]["zulip_calls"] == 0
    assert by_key(plan) == {f"topic:{AGENT}/{PLAN}": READY, f"topic:{TOOL}/{CHILD}": DONE,
                            "topic:front/front-desk-1": READY}
    assert plan["depends_on"]["channels"] == SCOPED
    assert door.plan(ROOT)["fingerprint"] == plan["fingerprint"] and door.discoveries == 1
    calls = asked(mirror)
    closed = door.close(ROOT, plan["fingerprint"])
    assert door.discoveries == 1, "the close reused the preview's walk"
    assert closed["revalidated"]["channels"] == SCOPED
    assert closed["revalidated"]["changed"] == [] and closed["revalidated"]["zulip_calls"] == 3
    assert asked(mirror) - calls == 3, "one listing per scoped channel, nothing else"
    assert outcomes(closed) == {f"topic:{AGENT}/{PLAN}": APPLIED, f"topic:{TOOL}/{CHILD}": ALREADY,
                                "topic:front/front-desk-1": APPLIED}
    assert all(r["confirmed"] for r in closed["results"] if r["outcome"] == APPLIED)
    assert not closed["partial"] and closed["applied"]
    assert by_key(closed)["topic:front/front-desk-1"] == DONE
    assert writer.resolved == [(AGENT, PLAN), ("front", "front-desk-1")] and writer.posted == []
    # A second preview reads the copy, which carries the writes: everything is done.
    after = door.plan(ROOT)
    assert set(by_key(after).values()) == {DONE} and after["gaps"]["zulip_calls"] == 0
    mirror.stop()


def test_a_child_added_after_the_preview_is_found_before_anything_is_written():
    realm = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    # Event lag: the agent opens a second child and no event has arrived.
    second = "toolrun-b"
    selfnote(realm, TOOL, second, "rootchat", f"{AGENT}/{PLAN}", sender_id=TOOL_BOT, sender="agtool")
    posted = realm.post(TOOL, second, "another step", sender_id=TOOL_BOT, sender_name="agtool", quiet=True)
    selfnote(realm, AGENT, PLAN, "served", f"{TOOL}/{second} {posted}")
    time.sleep(0.3)
    assert mirror.topic(TOOL, second) == [], "the mirror has not heard of it"
    refused = door.close(ROOT, plan["fingerprint"])
    assert refused["refused"] is True and writer.resolved == [] and writer.posted == []
    assert f"{TOOL}/{second}" in refused["revalidated"]["changed"]
    assert by_key(refused)[f"topic:{TOOL}/{second}"] == READY
    assert by_key(refused)["topic:front/front-desk-1"] == READY
    assert door.discoveries == 2
    mirror.stop()


def test_a_related_topic_resolved_since_the_preview_refuses_the_stale_approval():
    realm = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    assert by_key(plan)[f"topic:{AGENT}/{PLAN}"] == READY
    realm.resolve(AGENT, PLAN, quiet=True)
    refused = door.close(ROOT, plan["fingerprint"])
    assert refused["refused"] is True and writer.resolved == [] and writer.posted == []
    assert by_key(refused)[f"topic:{AGENT}/{PLAN}"] == DONE
    assert f"{AGENT}/✔ {PLAN}" in refused["revalidated"]["changed"]
    mirror.stop()


def test_an_edit_already_received_by_the_mirror_refuses_the_stale_approval():
    realm = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    assert by_key(plan)[f"topic:{TOOL}/{CHILD}"] == DONE
    # The child's root note is edited to name another request: it is not
    # this one's any more.
    note_id = message_id(realm, TOOL, f"✔ {CHILD}", f"[selfnote][rootchat] {AGENT}/{PLAN}")
    revision = mirror.revision()
    realm.edit(note_id, "[selfnote][rootchat] front/front-desk-other")
    mirror.wait(revision, timeout=3.0)
    assert mirror.message(note_id).content == "[selfnote][rootchat] front/front-desk-other"

    refused = door.close(ROOT, plan["fingerprint"])

    assert refused["refused"] is True
    assert f"topic:{TOOL}/{CHILD}" not in by_key(refused)
    assert any(row["topic"] == CHILD for row in refused["excluded"])
    assert writer.resolved == [] and writer.posted == []
    mirror.stop()


def test_deleting_an_older_link_note_invalidates_evidence_without_moving_the_topic_maximum():
    realm = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    assert f"topic:{TOOL}/{CHILD}" in by_key(plan)
    served_id = next(ident for ident, message in realm.messages.items()
                     if message["display_recipient"] == AGENT and message["subject"] == PLAN
                     and message["content"].startswith("[selfnote][served]"))
    maximum = mirror.topic(AGENT, PLAN)[0].max_id
    revision = mirror.revision()

    realm.delete(served_id)
    mirror.wait(revision, timeout=3.0)

    assert mirror.message(served_id) is None
    assert mirror.topic(AGENT, PLAN)[0].max_id == maximum
    refused = door.close(ROOT, plan["fingerprint"])
    assert refused["refused"] is True
    assert f"topic:{TOOL}/{CHILD}" not in by_key(refused)
    assert writer.resolved == [] and writer.posted == []
    mirror.stop()


def test_an_edit_in_an_unrelated_conversation_keeps_the_remembered_discovery():
    realm = chain()
    realm.add_channel(9, "other-agent")
    older = realm.post("other-agent", "other-topic", "old", quiet=True)
    realm.post("other-agent", "other-topic", "newer", quiet=True)
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
    realm = chain()
    realm.add_channel(9, "other-agent")
    first = realm.post("other-agent", "other-topic", "first", quiet=True)
    second = realm.post("other-agent", "other-topic", "second", quiet=True)
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
    realm = chain()
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
    realm = chain()
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
    assert writer.resolved == [] and writer.posted == []
    mirror.stop()


def test_one_failed_scoped_listing_stops_every_completion_write(monkeypatch):
    realm = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    refresh = mirror.refresh_listing

    def one_unreadable(channel):
        if channel == AGENT:
            raise ConnectionError("only this channel is unavailable")
        return refresh(channel)

    monkeypatch.setattr(mirror, "refresh_listing", one_unreadable)
    failed = door.close(ROOT, plan["fingerprint"])

    assert failed["verification_failed"] is True
    assert failed["revalidated"]["failures"] == [
        {"channel": AGENT, "reason": "ConnectionError: only this channel is unavailable"}
    ]
    assert writer.resolved == [] and writer.posted == []
    mirror.stop()


def test_a_rate_limit_is_a_retryable_verification_failure(monkeypatch):
    realm = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    monkeypatch.setattr(
        mirror, "refresh_listing",
        lambda _channel: (_ for _ in ()).throw(RateLimited("quota paused", retry_after=1)),
    )

    failed = door.close(ROOT, plan["fingerprint"])

    assert failed["verification_failed"] is True and failed["retryable"] is True
    assert all(row["reason"].startswith("RateLimited:") for row in failed["revalidated"]["failures"])
    assert writer.resolved == [] and writer.posted == []
    mirror.stop()


def test_retry_after_verification_recovers_and_completes(monkeypatch):
    realm = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    refresh = mirror.refresh_listing
    monkeypatch.setattr(
        mirror, "refresh_listing",
        lambda _channel: (_ for _ in ()).throw(ConnectionError("temporary outage")),
    )
    failed = door.close(ROOT, plan["fingerprint"])
    assert failed["verification_failed"] is True and writer.resolved == []

    monkeypatch.setattr(mirror, "refresh_listing", refresh)
    closed = door.close(ROOT, plan["fingerprint"])

    assert closed["applied"] is True and not closed.get("refused")
    assert closed["revalidated"]["ok"] is True
    assert not closed["partial"]
    mirror.stop()


def test_retry_refuses_old_approval_when_work_changed_during_failed_verification(monkeypatch):
    realm = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    refresh = mirror.refresh_listing
    monkeypatch.setattr(
        mirror, "refresh_listing",
        lambda _channel: (_ for _ in ()).throw(ConnectionError("temporary outage")),
    )
    failed = door.close(ROOT, plan["fingerprint"])
    assert failed["verification_failed"] is True

    realm.resolve(AGENT, PLAN, quiet=True)
    monkeypatch.setattr(mirror, "refresh_listing", refresh)
    refused = door.close(ROOT, plan["fingerprint"])

    assert refused["refused"] is True
    assert by_key(refused)[f"topic:{AGENT}/{PLAN}"] == DONE
    assert writer.resolved == [] and writer.posted == []
    mirror.stop()


def test_a_partial_failure_is_reported_per_target_and_the_retry_finishes_it():
    realm = chain()
    door, writer, mirror = door_over(realm, fail={("topic", PLAN)})
    plan = door.plan(ROOT)
    closed = door.close(ROOT, plan["fingerprint"])
    assert outcomes(closed) == {f"topic:{AGENT}/{PLAN}": FAILED, f"topic:{TOOL}/{CHILD}": ALREADY,
                                "topic:front/front-desk-1": SKIPPED}
    assert closed["partial"] is True
    shown = by_key(closed)
    assert shown[f"topic:{AGENT}/{PLAN}"] == READY and shown["topic:front/front-desk-1"] == READY
    assert "failed" in next(a["reason"] for a in closed["actions"] if a["key"] == f"topic:{AGENT}/{PLAN}")
    # The retry approves the post-write plan; the realm now accepts the rename.
    writer.fail.clear()
    again = door.close(ROOT, closed["fingerprint"])
    assert not again.get("refused"), again.get("error")
    assert outcomes(again) == {f"topic:{AGENT}/{PLAN}": APPLIED, f"topic:{TOOL}/{CHILD}": ALREADY,
                               "topic:front/front-desk-1": APPLIED}
    assert writer.resolved == [(AGENT, PLAN), ("front", "front-desk-1")], "nothing was resolved twice"
    assert not again["partial"]
    mirror.stop()


def test_growth_elsewhere_costs_the_close_nothing():
    realm = chain()
    door, writer, mirror = door_over(realm)
    plan = door.plan(ROOT)
    realm.create_channel(9, "other-agent")
    for n in range(5):
        realm.post("other-agent", f"other-{n}", "busy elsewhere", sender_id=AGENT_BOT, sender_name="agecho")
    time.sleep(0.4)
    assert mirror.channel("other-agent") is not None
    closed = door.close(ROOT, plan["fingerprint"])
    assert not closed.get("refused") and closed["revalidated"]["channels"] == SCOPED
    assert closed["revalidated"]["zulip_calls"] == 3, closed["revalidated"]
    assert door.discoveries == 1
    # No listing of `other-agent`.
    ledger = mirror.health()["ledger"]
    assert ledger.get("verify GET topics", 0) == 3
    mirror.stop()
