"""The two rules the plan makes non-negotiable, tested against made-up messages.

Live Zulip cannot prove either of them today: the realm's `intro-` topics
happen to contain no selfnote and no Zulip notice, so a broken filter would
read exactly like a working one. These are the messages that would break it.
"""

from agentroom.room import _readable, bare_topic, strip_selfnotes, unresolved


def message(content: str, *, ident: int = 1, system: bool = False) -> dict:
    return {
        "id": ident,
        "content": content,
        "timestamp": 1700000000,
        "sender_full_name": "Notification Bot" if system else "autolab-agstudio1",
        "sender_realm_str": "zulipinternal" if system else "agdev",
    }


def test_resolved_topics_are_recognised_by_zulips_own_marker():
    assert unresolved("workplan-thing")
    assert not unresolved("✔ workplan-thing")
    assert bare_topic("✔ workplan-thing") == "workplan-thing"
    assert bare_topic("workplan-thing") == "workplan-thing"


def test_a_topic_named_with_a_tick_elsewhere_is_still_unresolved():
    # The marker is a prefix, not a character anywhere in the name.
    assert unresolved("workplan-✔-in-the-middle")


def test_selfnote_lines_are_stripped_from_an_otherwise_ordinary_post():
    content = "[selfnote][rootchat] front/front-1\nHere is the plan.\nSecond line."
    assert strip_selfnotes(content) == "Here is the plan.\nSecond line."


def test_a_whole_selfnote_message_is_not_a_post():
    posts = _readable([
        message("[selfnote][served] pj-x/workplan-y 42", ident=1),
        message("Real answer.", ident=2),
    ])
    assert [post["id"] for post in posts] == [2]


def test_zulip_notices_are_not_posts():
    posts = _readable([
        message("@_**Developer|8** has marked this topic as resolved.", ident=1, system=True),
        message("Real answer.", ident=2),
    ])
    assert [post["id"] for post in posts] == [2]


def test_a_post_that_was_only_a_note_leaves_nothing_behind():
    assert _readable([message("[selfnote][work] project/1", ident=1)]) == []
