"""Completion from any work view (`front_desk` p4 step 1).

Fixtures only. What is pinned: each supported root kind draws its own
boundary — a Front Desk conversation, an ordinary Front conversation, one
run of a routine, an argue — through the same walk and the same ownership
rule; a topic that carries a root note names its parent instead of closing
it; nested delegation is owned to the bottom; another request reached by a
link stays outside, whatever kind it is; a routine's guide is context and
never a target; a resolved intermediate is walked through; and the two
topics whose ✔ means something else are never roots.

The delegated chain is an agent's own channel: Front serves
`#agecho-agstudio1 › agechoplan-trend8`, which serves the resolved
`agechorun-trend8`, which serves `#agnote-agstudio1 › notes-trend8` — each
level anchored to the one above by its own `[rootchat]` note.
"""



from agentroom.close import BLOCKED, DONE, READY, Closer, parse_key, plan_actions
from agentroom.closing import (
    ARGUE, DESK, FRONT, INTRO, ROUTINE_GUIDE, ROUTINE_RUN, TOPIC, classify, discover,
)

DESK_TOPIC = "front-desk-20260908-1600"
ROOT = ("front", DESK_TOPIC)
FRONT_BOT, AGECHO_BOT, AGNOTE_BOT, DEVELOPER = 15, 11, 9, 8
AGECHO = "agecho-agstudio1"
AGNOTE = "agnote-agstudio1"
PLAN_TOPIC = "agechoplan-trend8"
STEP_TOPIC = "agechorun-trend8"
NOTE_TOPIC = "notes-trend8"
FRONT_TOPIC = "front-ask-20260909-0900"
ROUTINE = "ghtrends"
RUN_CHANNEL = f"routine-{ROUTINE}"
RUN_TOPIC, EARLIER_TOPIC = "routinerun-20260909-0100", "routinerun-20260908-0100"
GUIDE = "guide"
#: A run's opening post, by Front (`refine_routine` p1): the request, the
#: conditions, the guide post read, and where the request came from.
OPENING = ("Routine run opened. Requested in #front › front-desk-20260909-0059 (message 1): "
           "\"run ghtrends\". Guide: #routine-ghtrends › guide, message 100.")


def post(ident, content, *, sender_id=FRONT_BOT, sender="Front"):
    return {"id": ident, "sender_id": sender_id, "sender_full_name": sender,
            "sender_realm_str": "agdev", "timestamp": 1_800_000_000 + ident,
            "content": content}


def selfnote(ident, tag, value, **kwargs):
    return post(ident, f"[selfnote][{tag}] {value}", **kwargs)


class Realm:
    """Topic histories under whichever name each one actually has."""

    def __init__(self, histories, topics=None, fail=(), streams=None):
        self.histories = dict(histories)
        self.topics = dict(topics or {})
        self.fail = set(fail)
        self.streams = dict(streams or {})
        self.reads = []

    def topic_history(self, channel, topic, num_before=50):
        self.reads.append((channel, topic))
        if channel in self.fail or (channel, topic) in self.fail:
            raise ConnectionError("realm down")
        return list(self.histories.get((channel, topic), []))

    def stream_id(self, name):
        if name not in self.streams:
            raise KeyError(name)
        return self.streams[name]

    def channel_topics(self, stream_id):
        for name, ident in self.streams.items():
            if ident == stream_id:
                return list(self.topics.get(name, []))
        raise KeyError(stream_id)

    def channels(self):
        return [{"name": name, "stream_id": ident} for name, ident in self.streams.items()]


class WritingRealm:
    """A read realm that also takes the one write this operation makes."""

    def __init__(self, realm):
        self.realm = realm
        self.resolved, self.posted = [], []

    def __getattr__(self, name):
        return getattr(self.realm, name)

    def resolve_topic(self, message_id, topic):
        self.resolved.append((message_id, topic))
        for (channel, name), history in list(self.realm.histories.items()):
            if name.removeprefix("✔ ") == topic:
                self.realm.histories.pop((channel, name))
                self.realm.histories[(channel, f"✔ {topic}")] = history
                self.realm.topics[channel] = [
                    f"✔ {topic}" if one.removeprefix("✔ ") == topic else one
                    for one in self.realm.topics.get(channel, [])
                ]

    def send_to_channel(self, channel, topic, content):
        self.posted.append((channel, topic, content))
        return 0


def closer(realm=None, topics=None):
    realm = realm if realm is not None else WritingRealm(chain_realm())
    door = Closer(topics=(lambda: dict(topics or {})),
                  reader_factory=lambda: realm, writer_factory=lambda: realm)
    return door, realm


def chain_realm(root=ROOT, **kwargs):
    """The whole delegated shape, opened for `root`."""
    histories = {
        root: [
            post(1, "Please cover a new trending repo.", sender_id=DEVELOPER, sender="Developer"),
            selfnote(2, "served", f"{AGECHO}/{PLAN_TOPIC} 1"),
            post(4, "Done — the summary is written up."),
        ],
        (AGECHO, PLAN_TOPIC): [
            selfnote(10, "rootchat", f"{root[0]}/{root[1]}", sender_id=AGECHO_BOT, sender=AGECHO),
            post(11, "Planning one summary.", sender_id=AGECHO_BOT, sender=AGECHO),
            selfnote(12, "served", f"{AGECHO}/{STEP_TOPIC} 1", sender_id=AGECHO_BOT, sender=AGECHO),
        ],
        (AGECHO, f"✔ {STEP_TOPIC}"): [
            selfnote(20, "rootchat", f"{AGECHO}/{PLAN_TOPIC}", sender_id=AGECHO_BOT, sender=AGECHO),
            post(21, "Summarizing.", sender_id=AGECHO_BOT, sender=AGECHO),
            selfnote(22, "served", f"{AGNOTE}/{NOTE_TOPIC} 1", sender_id=AGECHO_BOT, sender=AGECHO),
        ],
        (AGNOTE, NOTE_TOPIC): [
            selfnote(30, "rootchat", f"{AGECHO}/{STEP_TOPIC}", sender_id=AGNOTE_BOT, sender=AGNOTE),
            post(31, "Noted.", sender_id=AGNOTE_BOT, sender=AGNOTE),
        ],
    }
    topics = {root[0]: [root[1]], AGECHO: [PLAN_TOPIC, f"✔ {STEP_TOPIC}"], AGNOTE: [NOTE_TOPIC]}
    streams = {"front": 24, AGECHO: 79, AGNOTE: 34, RUN_CHANNEL: 50, "argue": 169}
    histories.update(kwargs.pop("histories", {}))
    for channel, names in kwargs.pop("topics", {}).items():
        topics[channel] = names
    return Realm(histories, topics=topics, streams=streams, **kwargs)


CHAIN = [(AGECHO, PLAN_TOPIC), (AGECHO, STEP_TOPIC), (AGNOTE, NOTE_TOPIC)]


def topic_keys(found):
    return [(node.channel, node.topic) for node in found.topics]


def excluded_of(found, topic):
    return next(row for row in found.excluded if row["topic"] == topic)


# --- what a conversation is -----------------------------------------------------


def test_a_conversation_is_classified_by_its_channel_and_bare_name():
    assert classify("front", DESK_TOPIC) == DESK
    assert classify("front", f"✔ {DESK_TOPIC}") == DESK
    assert classify("front", FRONT_TOPIC) == FRONT
    assert classify(RUN_CHANNEL, RUN_TOPIC) == ROUTINE_RUN
    assert classify(RUN_CHANNEL, f"✔ {RUN_TOPIC}") == ROUTINE_RUN
    assert classify(RUN_CHANNEL, GUIDE) == ROUTINE_GUIDE
    assert classify(RUN_CHANNEL, "anything else") == TOPIC
    assert classify("front", "routine-ghtrends") == TOPIC  # the pre-p1 standing request
    assert classify("front", "front-routine-ghtrends") == FRONT  # the pre-p7 shared topic
    assert classify("agents", "intro-agecho-agstudio1") == INTRO
    assert classify(AGECHO, PLAN_TOPIC) == TOPIC
    assert classify(AGECHO, "how is the board") == TOPIC
    assert classify("front", "something else") == TOPIC


# --- each supported root -----------------------------------------------------------


def test_a_front_desk_conversation_is_a_root_with_the_whole_chain():
    found = discover({}, ROOT, realm=chain_realm())
    assert found.scope.kind == DESK and found.scope.closable
    assert topic_keys(found) == [ROOT, *CHAIN]
    assert found.excluded == []


def test_an_ordinary_front_conversation_is_a_root_with_the_whole_chain():
    """The same delegated shape, anchored to a `front-*` topic Front opened
    for a chat request rather than for the desk."""
    found = discover({}, ("front", FRONT_TOPIC), realm=chain_realm(("front", FRONT_TOPIC)))
    assert found.scope.kind == FRONT and found.scope.closable
    assert "whole Front conversation" in found.scope.description
    assert topic_keys(found) == [("front", FRONT_TOPIC), *CHAIN]


def routine_realm(**kwargs):
    """One run of a routine, with the run before it on the realm, each with
    work of its own."""
    histories = {
        (RUN_CHANNEL, GUIDE): [
            post(100, "Summarise trending repos.", sender_id=DEVELOPER, sender="Developer"),
        ],
        (RUN_CHANNEL, RUN_TOPIC): [
            post(200, OPENING),
            selfnote(201, "served", f"{AGECHO}/{PLAN_TOPIC} 1"),
            post(202, "Done — the summary is written up."),
        ],
        (RUN_CHANNEL, f"✔ {EARLIER_TOPIC}"): [
            post(150, OPENING),
            selfnote(151, "served", f"{AGECHO}/agechoplan-trend7 1"),
            post(152, "Done — the earlier one is written up."),
        ],
        (AGECHO, "✔ agechoplan-trend7"): [
            selfnote(60, "rootchat", f"{RUN_CHANNEL}/{EARLIER_TOPIC}",
                     sender_id=AGECHO_BOT, sender=AGECHO),
            post(62, "An earlier summary.", sender_id=AGECHO_BOT, sender=AGECHO),
        ],
    }
    histories.update(kwargs.pop("histories", {}))
    topics = {RUN_CHANNEL: [GUIDE, RUN_TOPIC, f"✔ {EARLIER_TOPIC}"],
              AGECHO: [PLAN_TOPIC, f"✔ {STEP_TOPIC}", "✔ agechoplan-trend7"]}
    topics.update(kwargs.pop("topics", {}))
    return chain_realm((RUN_CHANNEL, RUN_TOPIC), histories=histories, topics=topics, **kwargs)


def test_a_routine_run_closes_that_run_and_its_work_only():
    found = discover({}, (RUN_CHANNEL, RUN_TOPIC), realm=routine_realm())
    assert found.scope.kind == ROUTINE_RUN and found.scope.closable
    assert found.scope.routine == {"name": ROUTINE, "channel": RUN_CHANNEL, "run_topic": RUN_TOPIC,
                                   "guide_topic": GUIDE}
    assert topic_keys(found) == [(RUN_CHANNEL, RUN_TOPIC), *CHAIN]
    # The guide is named as context — untouched, and said so — never
    # reached, never a target; the earlier run is simply not this run's.
    assert [(row["topic"], row["relation"]) for row in found.scope.context] == [(GUIDE, "guide")]
    assert "other runs are not touched" in found.scope.description
    assert all(row["topic"] not in {GUIDE, EARLIER_TOPIC, "agechoplan-trend7"}
               for row in found.excluded)
    keys = {action.key for action in plan_actions(found)}
    assert f"topic:{RUN_CHANNEL}/{GUIDE}" not in keys and f"topic:{RUN_CHANNEL}/{EARLIER_TOPIC}" not in keys
    assert f"topic:{RUN_CHANNEL}/{RUN_TOPIC}" in keys and f"topic:{AGECHO}/agechoplan-trend7" not in keys


def test_a_previous_run_reached_by_a_link_is_still_another_request():
    """Even when a note *does* name the earlier run — say Front served a
    late callback from it — it is another run, and its work is its own."""
    realm = routine_realm(histories={
        (RUN_CHANNEL, RUN_TOPIC): [
            post(200, OPENING),
            selfnote(201, "served", f"{AGECHO}/{PLAN_TOPIC} 1"),
            selfnote(203, "served", f"{RUN_CHANNEL}/{EARLIER_TOPIC} 152"),
            selfnote(204, "served", f"{RUN_CHANNEL}/{GUIDE} 100"),
        ],
    })
    found = discover({}, (RUN_CHANNEL, RUN_TOPIC), realm=realm)
    assert excluded_of(found, EARLIER_TOPIC)["reason"] == (
        f"another request: a run of routine {ROUTINE}")
    assert excluded_of(found, GUIDE)["reason"] == (
        f"the guide of routine {ROUTINE}: a ✔ there means something else")
    assert "agechoplan-trend7" not in {node.topic for node in found.topics}
    assert (AGNOTE, NOTE_TOPIC) in topic_keys(found)


def test_the_guide_is_never_a_root():
    found = discover({}, (RUN_CHANNEL, GUIDE), realm=routine_realm())
    assert found.scope.closable is False and "retires the routine" in found.scope.reason
    [action] = plan_actions(found)
    assert action.state == BLOCKED and action.reason == found.scope.reason


def test_an_introduction_is_never_a_root():
    realm = Realm({("agents", "intro-agecho-agstudio1"): [post(1, "hello", sender_id=AGECHO_BOT)]},
                  streams={"agents": 3})
    found = discover({}, ("agents", "intro-agecho-agstudio1"), realm=realm)
    assert found.scope.kind == INTRO and found.scope.closable is False
    assert "retires the agent" in found.scope.reason


# --- a topic with a root note names its parent ----------------------------------------


def test_a_topic_with_a_root_note_offers_its_parent_and_closes_nothing():
    found = discover({}, (AGECHO, PLAN_TOPIC), realm=chain_realm())
    assert found.scope.kind == TOPIC and found.scope.closable is False
    assert [(p["channel"], p["topic"], p["kind"], p["message_id"]) for p in found.scope.parents] == [
        ("front", DESK_TOPIC, DESK, 10)]
    assert "select that request" in found.scope.reason
    assert found.scope.description.endswith("is an execution topic, not a request")
    # What the walk reached beyond it is the parent's, and said so.
    assert {row["reason"] for row in found.excluded} == {"belongs to the parent request"}
    [action] = plan_actions(found)
    assert action.kind == "conversation" and action.state == BLOCKED
    assert action.detail["parents"] == found.scope.parents


def test_a_topic_without_a_root_note_is_its_own_request():
    realm = Realm({(AGECHO, "how is the board"): [
        post(1, "how is the board?", sender_id=DEVELOPER, sender="Developer"),
        post(2, "three plans open.", sender_id=AGECHO_BOT, sender=AGECHO),
    ]}, streams={AGECHO: 40}, topics={AGECHO: ["how is the board"]})
    found = discover({}, (AGECHO, "how is the board"), realm=realm)
    assert found.scope.kind == TOPIC and found.scope.closable
    [action] = plan_actions(found)
    assert action.kind == "conversation" and action.state == READY


def test_closing_the_selected_request_never_touches_its_parent():
    """A Front conversation opened for the desk: completing it closes its
    chain and itself, names the desk as where it came from, and leaves it."""
    realm = chain_realm(("front", FRONT_TOPIC))
    realm.histories[("front", FRONT_TOPIC)].insert(
        0, selfnote(0, "rootchat", f"front/{DESK_TOPIC}"))
    realm.histories[ROOT] = [post(90, "Please ask Front.", sender_id=DEVELOPER, sender="Developer")]
    realm.topics["front"] = [DESK_TOPIC, FRONT_TOPIC]
    found = discover({}, ("front", FRONT_TOPIC), realm=realm)
    assert found.scope.closable
    assert [(p["topic"], p["kind"]) for p in found.scope.parents] == [(DESK_TOPIC, DESK)]
    assert "which stays open" in found.scope.description
    door, writer = closer(realm=WritingRealm(realm))
    applied = door.close(("front", FRONT_TOPIC))
    assert applied["applied"] is True and applied["partial"] is False
    assert [topic for _, topic in writer.resolved] == [PLAN_TOPIC, NOTE_TOPIC, FRONT_TOPIC]
    assert DESK_TOPIC not in [topic for _, topic in writer.resolved]
    assert writer.posted == []


# --- ownership -----------------------------------------------------------------------


def test_a_topic_anchored_to_another_front_conversation_is_not_this_one_s():
    """A reused topic, met from the desk: its first root note names an
    ordinary `front-*` conversation."""
    realm = chain_realm(histories={
        (AGECHO, PLAN_TOPIC): [
            selfnote(9, "rootchat", f"front/{FRONT_TOPIC}"),
            selfnote(10, "rootchat", f"front/{DESK_TOPIC}"),
            selfnote(12, "served", f"{AGECHO}/{STEP_TOPIC} 1"),
        ],
    })
    found = discover({}, ROOT, realm=realm)
    shared = excluded_of(found, PLAN_TOPIC)
    assert shared["reason"] == f"anchored to another request (front/{FRONT_TOPIC})"
    assert [row["message_id"] for row in shared["evidence"]] == [9]
    assert shared["kind"] == TOPIC
    assert topic_keys(found) == [ROOT]
    cascaded = excluded_of(found, STEP_TOPIC)
    assert cascaded["reason"] == ("reached only through a conversation this one does not own "
                                  f"({PLAN_TOPIC})")


def test_another_request_of_every_kind_is_outside_the_closure():
    """Each request kind, reached from the desk by a served note with no root
    note of its own naming us, is excluded as *another request*."""
    others = {
        ("front", FRONT_TOPIC): "a Front conversation",
        ("front", "front-desk-20260907-0900"): "a Front Desk conversation",
        (RUN_CHANNEL, RUN_TOPIC): f"a run of routine {ROUTINE}",
        ("argue", "argue-other"): "an argue",
    }
    histories = {ROOT: [
        post(1, "hello", sender_id=DEVELOPER, sender="Developer"),
        *[selfnote(2 + i, "served", f"{ch}/{tp} 1") for i, (ch, tp) in enumerate(others)],
    ]}
    for channel, topic in others:
        histories[(channel, topic)] = [post(50, "somebody's conversation")]
    realm = chain_realm(histories=histories, topics={RUN_CHANNEL: [RUN_TOPIC], "argue": ["argue-other"]})
    found = discover({}, ROOT, realm=realm)
    assert topic_keys(found) == [ROOT]
    for (channel, topic), what in others.items():
        assert excluded_of(found, topic)["reason"] == f"another request: {what}"


def test_nested_delegation_is_owned_to_the_bottom_from_a_routine_run():
    """run → plan → step → note: every level carries a root note naming the
    level above, and the walk owns all of it."""
    found = discover({}, (RUN_CHANNEL, RUN_TOPIC), realm=routine_realm())
    depths = {node.topic: node.depth for node in found.topics}
    assert depths == {RUN_TOPIC: 0, PLAN_TOPIC: 1, STEP_TOPIC: 2, NOTE_TOPIC: 3}
    assert found.excluded == []


def test_a_resolved_intermediate_is_walked_through():
    realm = chain_realm(topics={AGECHO: [f"✔ {PLAN_TOPIC}", f"✔ {STEP_TOPIC}"]})
    realm.histories[(AGECHO, f"✔ {PLAN_TOPIC}")] = realm.histories.pop((AGECHO, PLAN_TOPIC))
    found = discover({}, ROOT, realm=realm)
    plan = next(node for node in found.topics if node.topic == PLAN_TOPIC)
    assert plan.resolved is True
    assert (AGNOTE, NOTE_TOPIC) in topic_keys(found)


def test_a_topic_nothing_links_is_not_this_request_s():
    """Missing relationship evidence: a topic beside the chain with no root
    note and nothing naming it is neither a target nor silently swept in."""
    realm = chain_realm(topics={AGECHO: [PLAN_TOPIC, f"✔ {STEP_TOPIC}", "agechorun-trend9"]})
    realm.histories[(AGECHO, "agechorun-trend9")] = [
        post(60, "a step with no anchor", sender_id=AGECHO_BOT, sender=AGECHO)]
    found = discover({}, ROOT, realm=realm)
    assert (AGECHO, "agechorun-trend9") not in topic_keys(found)
    assert all(row["topic"] != "agechorun-trend9" for row in found.excluded)


def test_a_topic_anchored_to_an_owned_request_is_owned_whatever_reached_it():
    """A note topic anchored to our step is ours even when the only link that
    reached it came through a conversation we do not own."""
    realm = chain_realm(histories={
        ROOT: [
            post(1, "hello", sender_id=DEVELOPER, sender="Developer"),
            selfnote(2, "served", f"{AGECHO}/{PLAN_TOPIC} 1"),
            selfnote(3, "served", f"front/{FRONT_TOPIC} 1"),
        ],
        ("front", FRONT_TOPIC): [
            post(5, "another conversation", sender_id=DEVELOPER, sender="Developer"),
            selfnote(6, "served", f"{AGNOTE}/{NOTE_TOPIC} 1"),
        ],
        (AGECHO, f"✔ {STEP_TOPIC}"): [
            selfnote(20, "rootchat", f"{AGECHO}/{PLAN_TOPIC}", sender_id=AGECHO_BOT, sender=AGECHO),
        ],
    })
    found = discover({}, ROOT, realm=realm)
    assert excluded_of(found, FRONT_TOPIC)["reason"] == "another request: a Front conversation"
    assert (AGNOTE, NOTE_TOPIC) in topic_keys(found)


def test_a_parent_the_walk_never_named_is_read_upward_and_joins_by_its_own_note():
    """Front served a step but never the plan: the plan is reached only by
    reading the step's home, and it joins because *its* note names the run."""
    realm = routine_realm(histories={
        (RUN_CHANNEL, RUN_TOPIC): [
            post(200, OPENING),
            selfnote(201, "served", f"{AGECHO}/{STEP_TOPIC} 1"),
        ],
    })
    found = discover({}, (RUN_CHANNEL, RUN_TOPIC), realm=realm)
    plan = next(node for node in found.topics if node.topic == PLAN_TOPIC)
    assert plan.depth == 1 and [l["via"] for l in plan.links] == ["rootchat"]
    assert (AGECHO, STEP_TOPIC) in topic_keys(found)


def test_a_topic_in_an_archived_channel_is_kept_and_the_request_still_closes():
    """Met live: `front-p2-greet-agecho` reached `#agecho-agstudio1 › hello`,
    readable, unresolved — and the channel is archived, so the resolve was a
    400 and the conversation stayed open. Now it is kept, said so, and the
    request closes over it."""
    realm = Realm({
        ("front", FRONT_TOPIC): [
            post(1, "say hello to agecho", sender_id=DEVELOPER, sender="Developer"),
            selfnote(2, "served", f"{AGECHO}/hello 9"),
            post(3, "it said hello back"),
        ],
        (AGECHO, "hello"): [
            selfnote(8, "rootchat", f"front/{FRONT_TOPIC}"),
            post(9, "hello", sender_id=99, sender="agecho"),
        ],
    }, topics={"front": [FRONT_TOPIC]}, streams={"front": 24})
    door, _ = closer(realm=WritingRealm(realm))
    found = door.plan(("front", FRONT_TOPIC))
    by_key = {a["key"]: a for a in found["actions"]}
    hello = by_key[f"topic:{AGECHO}/hello"]
    assert hello["state"] == "kept" and "is archived" in hello["reason"]
    assert by_key[f"topic:front/{FRONT_TOPIC}"]["state"] == READY
    applied = door.close(("front", FRONT_TOPIC), found["fingerprint"])
    assert applied["partial"] is False
    outcomes = {row["key"]: row["outcome"] for row in applied["results"]}
    assert outcomes[f"topic:{AGECHO}/hello"] == "skipped"
    assert outcomes[f"topic:front/{FRONT_TOPIC}"] == "applied"


# --- the door and its routes ------------------------------------------------------------


def test_a_key_is_read_bare_and_refused_when_malformed():
    assert parse_key(AGECHO, f"✔ {PLAN_TOPIC}") == (AGECHO, PLAN_TOPIC)
    assert parse_key(" front ", " front-desk-1 ") == ("front", "front-desk-1")
    assert "strings" in parse_key(None, "x")["error"]
    assert "named" in parse_key("front", "")["error"]
    assert "one line" in parse_key("front", "a\nb")["error"]
    assert "at most" in parse_key("front", "x" * 201)["error"]


def test_the_door_takes_a_key_and_the_front_desk_id_is_one_caller():
    door, _ = closer()
    by_key = door.plan(ROOT)
    by_id = door.plan(Closer.desk_key("20260908-1600"))
    assert by_key["fingerprint"] == by_id["fingerprint"]
    assert by_key["scope"]["kind"] == DESK and by_key["root"] == {"channel": "front", "topic": DESK_TOPIC}
    assert door.plan(Closer.desk_key("../etc"))["error"].endswith("is not a Front Desk conversation id")
    assert door.plan(parse_key("front", ""))["error"] == "channel and topic must both be named"


def test_a_history_of_operations_is_kept_per_request():
    door, _ = closer()
    assert door.plan(ROOT)["history"] == []
    door.close(ROOT)
    door.close((AGECHO, PLAN_TOPIC))
    [record] = door.records(ROOT)
    assert record["kind"] == DESK and record["topic"] == DESK_TOPIC
    assert len(door.records()) == 2
    assert door.plan(ROOT)["history"] == [record]


def twin_realm():
    """`front-routine-publish-2026-09-08T17:09Z` on 2026-09-09: Front resolved
    the run and its last reply landed under the bare name, which Zulip made
    a second, open topic. The agent room lists the open one; the plan must
    see it too, and a ✔ must fold it rather than say *already ✔*."""
    realm = chain_realm(histories={
        ("front", f"✔ {DESK_TOPIC}"): [
            post(1, "Please cover a new trending repo.", sender_id=DEVELOPER, sender="Developer"),
            selfnote(2, "served", f"{AGECHO}/{PLAN_TOPIC} 1"),
            post(4, "Done — the summary is written up."),
        ],
        ROOT: [
            post(7, "Both topics are resolved."),
        ],
    })
    realm.topics["front"] = [f"✔ {DESK_TOPIC}", DESK_TOPIC]
    return realm


def test_a_resolved_topic_with_an_open_twin_is_open_and_the_twin_is_folded():
    door, realm = closer(realm=WritingRealm(twin_realm()))
    found = door.plan(ROOT)
    root_action = found["actions"][-1]
    assert root_action["state"] == READY
    assert "opened a twin" in root_action["reason"] and "1 post " in root_action["reason"]
    assert root_action["detail"]["twin"] is True and root_action["detail"]["last_post_id"] == 7
    # The walk still saw the served note under the ✔ name.
    assert (AGECHO, PLAN_TOPIC) in topic_keys(discover({}, ROOT, realm=twin_realm()))
    applied = door.close(ROOT, found["fingerprint"])
    assert applied["partial"] is False
    # The resolve moves the twin's own post, never one already under ✔.
    assert (7, DESK_TOPIC) in realm.resolved


def test_a_held_resolved_topic_is_asked_once_for_a_twin():
    from agentroom.ops import Topic
    held = Topic(channel="front", topic=DESK_TOPIC, live_topic=f"✔ {DESK_TOPIC}", resolved=True,
                 keep_history=True)
    for message in twin_realm().histories[("front", f"✔ {DESK_TOPIC}")]:
        held.add(message)
    realm = twin_realm()
    found = discover({ROOT: held}, ROOT, realm=realm)
    root = found.topics[0]
    assert root.twin is True and root.resolved is False and root.last_post_id == 7
    assert realm.reads.count(("front", DESK_TOPIC)) == 1


# --- an argue: the discussion only (`argue` p2 ex1) ---------------------------------


ARGUE_TOPIC = "argue-failfarm"
ARGUE_ROOT = ("argue", ARGUE_TOPIC)
OUTCOME_TOPIC = "agechoplan-failfarm"


def argue_realm(*, resolved=False, **kwargs):
    """An argue that ended in work: Front's outcome note, an agent's plan
    anchored to the argue by a root note, the step it served, and a memo of
    the rendering beside it."""
    name = f"✔ {ARGUE_TOPIC}" if resolved else ARGUE_TOPIC
    histories = {
        ("argue", name): [
            selfnote(300, "argue", f"from front/{DESK_TOPIC}", sender_id=DEVELOPER, sender="Developer"),
            post(301, "I want machines that learn from failure.", sender_id=DEVELOPER, sender="Developer"),
            post(302, f"What would failure look like? @**{AGECHO}** could you say?"),
            post(303, "A harness needs a failure record.", sender_id=AGECHO_BOT, sender=AGECHO),
            selfnote(304, "served", f"argue/{ARGUE_TOPIC} 302", sender_id=AGECHO_BOT, sender=AGECHO),
            selfnote(305, "desire", f"301 by {DEVELOPER}"),
            selfnote(306, "served", f"{AGECHO}/{OUTCOME_TOPIC} 317"),
            post(307, f"This became work: #{AGECHO} › {OUTCOME_TOPIC}."),
            selfnote(308, "outcome", f"plan {AGECHO}/{OUTCOME_TOPIC}"),
        ],
        (AGECHO, OUTCOME_TOPIC): [
            selfnote(310, "rootchat", f"argue/{ARGUE_TOPIC}"),
            post(311, "Please prepare the workspace.", sender_id=DEVELOPER, sender="Developer"),
            selfnote(313, "served", f"{AGECHO}/agechorun-failfarm 1", sender_id=AGECHO_BOT, sender=AGECHO),
            post(317, "The workspace is ready.", sender_id=AGECHO_BOT, sender=AGECHO),
        ],
        (AGECHO, "✔ agechorun-failfarm"): [
            selfnote(320, "rootchat", f"{AGECHO}/{OUTCOME_TOPIC}", sender_id=AGECHO_BOT, sender=AGECHO),
            post(322, "Set up.", sender_id=AGECHO_BOT, sender=AGECHO),
        ],
        ("memo", f"{ARGUE_TOPIC}-s300"): [
            selfnote(330, "memosource", "300"),
            post(331, "```ag-memo-dialogue\n{}\n```"),
        ],
        ROOT: [
            post(1, "Let us argue about failure.", sender_id=DEVELOPER, sender="Developer"),
            selfnote(2, "served", f"argue/{ARGUE_TOPIC} 307"),
        ],
    }
    topics = {"argue": [name], AGECHO: [OUTCOME_TOPIC, "✔ agechorun-failfarm"],
              "memo": [f"{ARGUE_TOPIC}-s300"], "front": [DESK_TOPIC]}
    streams = {"argue": 169, AGECHO: 180, "memo": 171, "front": 5}
    histories.update(kwargs.pop("histories", {}))
    topics.update(kwargs.pop("topics", {}))
    return Realm(histories, topics=topics, streams=streams, **kwargs)


def test_an_argue_is_classified_by_its_channel_and_prefix():
    assert classify("argue", ARGUE_TOPIC) == ARGUE
    assert classify("argue", f"✔ {ARGUE_TOPIC}") == ARGUE
    assert classify("argue", "something else") == TOPIC  # the channel alone is not an argue
    assert classify("front", ARGUE_TOPIC) == TOPIC  # nor is the prefix outside #argue


def test_closing_an_argue_is_the_discussion_only_and_says_what_stays_open():
    found = discover({}, ARGUE_ROOT, realm=argue_realm())
    assert found.scope.kind == ARGUE and found.scope.closable
    assert "the discussion only" in found.scope.description
    assert "stays open" in found.scope.description
    # The argue itself, and nothing downstream: the outcome plan is anchored
    # to the argue by a root note and would be owned by the ordinary rule.
    assert topic_keys(found) == [ARGUE_ROOT]
    downstream = {row["topic"]: row["reason"] for row in found.excluded}
    assert OUTCOME_TOPIC in downstream and "agechorun-failfarm" in downstream
    assert all("ends the discussion" in reason for reason in downstream.values())
    # The desk it was opened from and the memo are not in this graph at all.
    assert DESK_TOPIC not in downstream and f"{ARGUE_TOPIC}-s300" not in downstream
    assert found.scope.parents == []
    [action] = plan_actions(found)
    assert action.kind == "conversation" and action.state == READY
    assert action.key == f"topic:argue/{ARGUE_TOPIC}" and action.detail["last_post_id"] == 308


def test_a_human_close_of_an_argue_resolves_the_argue_and_writes_no_outcome():
    realm = WritingRealm(argue_realm())
    door, _ = closer(realm=realm)
    found = door.close(ARGUE_ROOT)
    assert found["applied"] is True and found["partial"] is False
    assert [topic for _, topic in realm.resolved] == [ARGUE_TOPIC]
    # No `[selfnote][outcome]`, no state note, no post of any kind: a ✔
    # without an outcome note is what "ended by the human" looks like.
    assert realm.posted == []
    assert OUTCOME_TOPIC not in [topic for _, topic in realm.resolved]


def test_a_resolved_argue_reports_already_done():
    found = discover({}, ARGUE_ROOT, realm=argue_realm(resolved=True))
    [action] = plan_actions(found)
    assert action.state == DONE and action.reason == "already ✔"
