"""The Project Room's read model (`project_room` p1 step 1), over a mirrored
fake realm.

Pinned: a project is its channel and its kind is read, never guessed; a
setup-only project and a study with a research plan and no mission both say
so as gaps; a mission is its anchor through a rename, a replacement is a
recorded relation and never a name match; a task belongs to its mission by
id and a mission whose work channel is not mirrored has an *incomplete*
count; documents are not work and are never assigned a mission; resolved
history stays readable; a stale mirror makes every reply state unknown; and
repeated board reads cost no Zulip call.
"""

import json
from http.client import HTTPConnection

from conftest import FakeRealm, mirror_over, pump

from agentroom.ops import Ops
from agentroom.projectroom import (
    DOCUMENT, MISSION, PLAN, SETUP, TASK, ProjectRoom, classify, links_in, parse_description, title_of,
)
from agentroom.room import Room
from agentroom.server import build_server

NOW = 1_800_000_000.0
DEV, FRONT, AUTOLAB = 8, 15, 11
ACK = "Message received. Please wait for the reply."
STALL = 900.0


def roster(instance, agent, bot, bot_id, prefixes):
    return (f"hello\n```agag-roster\nschema: ag.agent-roster.v1\ninstance: {instance}\nagent: {agent}\n"
            f"bot: {bot}\nbot_id: {bot_id}\nchannel: {instance}\nprefixes: {prefixes}\n```")


def world():
    realm = FakeRealm()
    realm.base_url = "https://zulip.invalid"
    realm.add_channel(35, "agents")
    realm.add_channel(169, "argue")
    realm.post("agents", "intro-front-x1", roster("front-x1", "front", "Front", FRONT, "front-, argue-"),
               sender_id=FRONT, sender_name="Front", quiet=True)
    realm.post("agents", "intro-autolab-x1", roster("autolab-x1", "autolab", "autolab-x1", AUTOLAB, "workplan-, workrun-"),
               sender_id=AUTOLAB, sender_name="autolab-x1", quiet=True)
    return realm


def room_over(realm):
    mirror = mirror_over(realm)
    ops = Ops(mirror=mirror, stalled_seconds=STALL, done_seconds=1e12)
    return mirror, ProjectRoom(mirror=mirror, ops=ops)


def dev(realm, channel, topic, text, *, at=NOW - 600):
    return realm.post(channel, topic, text, sender_id=DEV, sender_name="Developer", timestamp=int(at))


def bot(realm, channel, topic, text, *, at=NOW - 500):
    return realm.post(channel, topic, text, sender_id=AUTOLAB, sender_name="autolab-x1", timestamp=int(at))


def front(realm, channel, topic, text, *, at=NOW - 700):
    return realm.post(channel, topic, text, sender_id=FRONT, sender_name="Front", timestamp=int(at))


def open_project(realm, stream_id, slug, kind, *, folder, argue="argue-x", at=NOW - 3600):
    """What `agproject open` leaves behind: the channel, the document, the setup ask."""
    doc_topic = "goal" if kind == "project" else f"researchplan-{slug}"
    realm.add_channel(stream_id, f"pj-{slug}", folder_id=folder,
                      description=f"[AUTO] project: {slug}; {kind}; opened from argue argue/{argue}; its goal is the `{doc_topic}` topic")
    realm.post("argue", argue, "[selfnote][argue] from -", sender_id=DEV, sender_name="Developer", timestamp=int(at - 100))
    doc = front(realm, f"pj-{slug}", doc_topic, f"# {slug.title()} goal\n\nBuild the thing.\n\n---\nOpened from argue **#argue › {argue}**.", at=at)
    front(realm, f"pj-{slug}", f"workplan-setup-{slug}", f"[selfnote][rootchat] argue/{argue}", at=at)
    ask = front(realm, f"pj-{slug}", f"workplan-setup-{slug}", "Please prepare the workspace — setup only, no mission to plan.", at=at)
    return doc, ask


def mission(realm, channel, topic, slug, *, text="Plan it.", at=NOW - 3000, tasks=1, work_stream=None,
            states=()):
    """A mission as autolab records it: the ask, the ack, the anchor, the plan, the tasks."""
    dev(realm, channel, topic, f"**Mission:** {text}", at=at)
    bot(realm, channel, topic, ACK, at=at + 1)
    anchor = bot(realm, channel, topic, f"[selfnote][mission] {slug}", at=at + 2)
    doc = bot(realm, channel, topic, f"# Plan for {topic}\n\nTwo steps. Repository: https://git.invalid/autodev/{slug}.git", at=at + 3)
    bot(realm, channel, topic, f"[selfnote][doc] {doc}", at=at + 3)
    for word in states:
        bot(realm, channel, topic, f"[selfnote][state] {word}", at=at + 4)
    bot(realm, channel, topic, f"@**Developer**\n\nPlan and {tasks} task(s) are written.", at=at + 5)
    task_ids = []
    if work_stream is not None:
        work = f"work-m{anchor}"
        realm.add_channel(work_stream, work, folder_id=realm.channels_by_id[next(
            c["stream_id"] for c in realm.channels_by_id.values() if c["name"] == channel)]["folder_id"])
        for serial in range(1, tasks + 1):
            run = f"workrun-task{serial}-m{anchor}"
            task = bot(realm, work, run, f"[selfnote][task] {anchor}#{serial}", at=at + 10 * serial)
            bot(realm, work, run, f"[selfnote][rootchat] {channel}/{topic}", at=at + 10 * serial)
            tdoc = bot(realm, work, run, f"# Task {serial}\n\nDo step {serial}.", at=at + 10 * serial)
            bot(realm, work, run, f"[selfnote][doc] {tdoc}", at=at + 10 * serial)
            task_ids.append(task)
    return anchor, doc, task_ids


# --- reading one post ----------------------------------------------------------------


def test_the_description_says_the_kind_and_the_argue_and_an_older_channel_is_unknown():
    found = parse_description("[AUTO] project: desk-garden; project; opened from argue argue/argue-desk-garden; its goal is the `goal` topic")
    assert found["kind"] == "project" and found["origin"] == {"channel": "argue", "topic": "argue-desk-garden"}
    assert parse_description("autolab project: mediagen (study pattern)")["kind"] == "study"
    assert parse_description("Study project: arXiv trend summaries.")["kind"] == "study"
    assert parse_description("game based on foochain") == {"kind": "unknown", "origin": None, "text": "game based on foochain"}
    assert parse_description(None)["kind"] == "unknown"


def test_a_title_is_the_first_heading_and_links_are_filed_by_what_they_look_like():
    assert title_of("@**Front**\n\n# Desk grow box\n\n## Final goal") == "Desk grow box"
    assert title_of("[selfnote][x] y\nplain first line\nmore") == "plain first line"
    assert title_of("") == ""
    found = links_in("repo `http://agstudio.local:3000/autodev/x.git` and report https://x.invalid/reports/report.md, "
                     "see https://zulip.invalid/#narrow/channel/1-a/topic/b and https://example.invalid/page. twice https://example.invalid/page")
    assert [(l["kind"], l["url"]) for l in found] == [
        ("repository", "http://agstudio.local:3000/autodev/x.git"), ("report", "https://x.invalid/reports/report.md"),
        ("zulip", "https://zulip.invalid/#narrow/channel/1-a/topic/b"), ("other", "https://example.invalid/page")]


def test_a_record_outranks_a_name_and_names_are_told_apart():
    assert classify("goal", None) == DOCUMENT and classify("✔ researchplan-x", None) == DOCUMENT
    assert classify("workplan-setup-x", None) == SETUP and classify("workplan-x", None) == PLAN
    assert classify("notes", None) == "other"


# --- the shapes --------------------------------------------------------------------------


def test_a_setup_only_project_says_so_and_a_study_without_a_mission_says_the_plan_is_not_work():
    realm = world()
    open_project(realm, 170, "garden", "project", folder=19, argue="argue-garden")
    bot(realm, "pj-garden", "workplan-setup-garden", ACK)
    reply = bot(realm, "pj-garden", "workplan-setup-garden", "@**Front**\n\nSetup is done: `main/` at http://git.invalid/autodev/garden.git", at=NOW - 400)
    # Front served the callback from its home, so the mention is answered.
    front(realm, "argue", "argue-garden", f"[selfnote][served] pj-garden/workplan-setup-garden {reply}", at=NOW - 300)
    open_project(realm, 172, "trend", "study", folder=20, argue="argue-trend")
    mirror, room = room_over(realm)
    board = room.board(now=NOW)
    assert board["health"]["state"] == "live" and board["counts"] == {"projects": 2, "live": 2, "archived": 0}
    by = {row["channel"]: row for row in board["projects"]}
    garden = by["pj-garden"]
    assert garden["kind"] == "project" and garden["key"] == "170" and garden["slug"] == "garden"
    assert garden["origin"]["topic"] == "argue-garden" and garden["origin"]["anchor"] is not None
    assert [g["kind"] for g in garden["gaps"]] == ["setup-only"]
    assert garden["counts"]["documents"] == 1 and garden["counts"]["missions"] == 0 and garden["counts"]["setups"] == 1
    assert garden["documents"][0]["document_kind"] == "goal" and garden["documents"][0]["title"] == "Garden goal"
    # autolab answered the setup: nobody owes a reply there.
    assert garden["setups"][0]["reply"]["state"] == "quiet" and garden["reply"] == {"state": "quiet"}
    trend = by["pj-trend"]
    assert trend["kind"] == "study" and trend["documents"][0]["document_kind"] == "researchplan"
    # The setup ask is an hour unanswered: autolab owes a reply past the stalled
    # threshold, and the board leads with it.
    assert trend["setups"][0]["reply"]["state"] == "stalled" and trend["setups"][0]["reply"]["instance"] == "autolab-x1"
    assert trend["reply"] == {"state": "stalled"}
    assert [g["kind"] for g in trend["gaps"]] == ["setup-only"]

    detail = room.project("pj-garden", now=NOW)["project"]
    assert detail["documents"][0]["current"]["content"].startswith("# Garden goal")
    assert detail["documents"][0]["missions"] == [] and "not executable work" in detail["documents"][0]["note"]
    assert detail["setups"][0]["origins"][0] == {"channel": "argue", "topic": "argue-garden", "by": "Front", "by_id": FRONT,
                                                 "message_id": detail["setups"][0]["origins"][0]["message_id"]}
    assert [l["kind"] for l in detail["setups"][0]["links"]] == ["repository"]
    assert detail["setups"][0]["zulip_url"] == "https://zulip.invalid/#narrow/channel/170-pj-garden/topic/workplan-setup-garden"
    # A study with a research plan and no setup at all: the plan is not work.
    realm.create_channel(173, "pj-lone", folder_id=21, description="[AUTO] project: lone; study; opened from argue argue/argue-lone")
    front(realm, "pj-lone", "researchplan-lone", "# Lone plan")
    pump(mirror)
    lone = room.project("lone", now=NOW)["project"]
    assert [g["kind"] for g in lone["gaps"]] == ["no-mission"] and "not executable work" in lone["gaps"][0]["text"]


def test_missions_carry_their_tasks_by_id_with_counts_and_an_unmirrored_work_channel_is_incomplete():
    realm = world()
    realm.add_channel(93, "pj-media", folder_id=6, description="autolab project: media (study pattern)")
    m1, doc1, tasks1 = mission(realm, "pj-media", "workplan-one", "media", tasks=3, work_stream=200, states=("started",))
    work = f"work-m{m1}"
    bot(realm, work, f"workrun-task1-m{m1}", "[selfnote][state] completed", at=NOW - 2000)
    dev(realm, work, f"workrun-task2-m{m1}", "[selfnote][state] accepted", at=NOW - 1900)
    bot(realm, work, f"workrun-task3-m{m1}", "[selfnote][state] cancelled", at=NOW - 1800)
    dev(realm, work, f"workrun-task2-m{m1}", "Start task 2.", at=NOW - 100)   # autolab owes a reply here
    m2, doc2, _ = mission(realm, "pj-media", "workplan-two", "media", tasks=0, at=NOW - 2500)
    # An older plan, never recorded as a mission.
    dev(realm, "pj-media", "workplan-old", "Mission: do the old thing", at=NOW - 9000)
    bot(realm, "pj-media", "workplan-old", "planned it, the old way", at=NOW - 8900)
    # A mission whose work channel is archived: the tasks cannot be counted.
    realm.add_channel(94, "pj-old", folder_id=7, description="legacy")
    m3, _, _ = mission(realm, "pj-old", "workplan-gone", "old", tasks=0, at=NOW - 5000)
    realm.add_channel(201, f"work-m{m3}", folder_id=7, archived=True)
    mirror, room = room_over(realm)
    media = room.project("pj-media", now=NOW)["project"]
    assert media["kind"] == "study" and [g["kind"] for g in media["gaps"]] == ["no-document"]
    one, two = media["missions"]
    assert one["anchor"] == m1 and one["label"] == f"m{m1}" and one["work"]["state"] == "started" and not one["setup"]
    assert "does not prove" in one["work"]["note"]
    assert one["document"]["message_id"] == doc1 and one["document"]["title"] == "Plan for workplan-one"
    assert one["document"]["content"].startswith("# Plan for workplan-one")
    assert [l["kind"] for l in one["links"]] == ["repository"]
    assert one["task_counts"] == {"total": 3, "live": 2, "finished": 2, "completed": 1, "accepted": 1, "cancelled": 1, "open": 0}
    assert one["tasks_read"] == {"complete": True, "channel": work, "note": None}
    assert [(t["serial"], t["state"], t["finished"], t["anchor"]) for t in one["tasks"]] == [
        (1, "completed", True, tasks1[0]), (2, "accepted", True, tasks1[1]), (3, "cancelled", False, tasks1[2])]
    assert one["tasks"][0]["document"]["title"] == "Task 1" and one["tasks"][0]["origins"][0]["topic"] == "workplan-one"
    # The reply state is the ops engine's, beside the recorded state.
    assert one["tasks"][1]["reply"]["state"] == "awaiting" and one["tasks"][1]["reply"]["instance"] == "autolab-x1"
    assert one["tasks"][0]["reply"]["state"] == "quiet"
    assert one["reply"]["state"] == "quiet"  # autolab answered the plan
    assert two["task_counts"]["total"] == 0 and [g["kind"] for g in two["gaps"]] == ["tasks-unknown"]
    assert "none opened yet" in two["tasks_read"]["note"]
    assert media["plans"] == [{**media["plans"][0], "topic": "workplan-old", "kind": PLAN, "recorded": False}]
    assert media["counts"]["plans_unrecorded"] == 1 and media["counts"]["tasks"] == 3 and media["counts"]["tasks_finished"] == 2
    assert media["counts"]["open_missions"] == 2 and media["counts"]["missions_by_state"] == {"planned": 1, "started": 1}
    assert media["latest"]["topic"] == f"workrun-task2-m{m1}" and media["latest"]["kind"] == TASK
    old = room.project("94", now=NOW)["project"]
    (gone,) = old["missions"]
    assert gone["tasks_read"]["complete"] is False and "archived" in gone["tasks_read"]["note"]
    assert old["tasks_read"] == {"complete": False, "incomplete_missions": [f"m{m3}"]}
    board = {r["channel"]: r for r in room.board(now=NOW)["projects"]}
    assert board["pj-old"]["tasks_read"]["incomplete_missions"] == [f"m{m3}"]
    assert board["pj-media"]["missions"][0]["task_counts"]["finished"] == 2


def test_a_mission_is_its_anchor_through_a_rename_and_a_replacement_is_the_recorded_relation():
    realm = world()
    realm.add_channel(152, "pj-pol", folder_id=17, description="Study project: politics.")
    old, _, _ = mission(realm, "pj-pol", "workplan-collect", "pol", tasks=1, work_stream=300, at=NOW - 8000)
    dev(realm, "pj-pol", "workplan-collect", "Scrap this plan and re-ask.", at=NOW - 7000)
    bot(realm, "pj-pol", "workplan-collect", "[selfnote][state] replaced", at=NOW - 6900)
    # Retiring renames the whole conversation aside and the replacement takes the freed name.
    ids = sorted(i for i, m in realm.messages.items() if m["subject"] == "workplan-collect")
    realm.move(ids, f"✔ retired-workplan-collect-m{old}")
    bot(realm, "pj-pol", "workplan-collect", "[selfnote][mission] pol", at=NOW - 6800)
    new = max(realm.messages)
    bot(realm, "pj-pol", "workplan-collect", f"[selfnote][replaces] {old}", at=NOW - 6800)
    plan = bot(realm, "pj-pol", "workplan-collect", "# Replacement plan", at=NOW - 6800)
    bot(realm, "pj-pol", "workplan-collect", f"[selfnote][doc] {plan}", at=NOW - 6800)
    bot(realm, "pj-pol", "workplan-collect", "@**Developer**\n\nReplacing.", at=NOW - 6700)
    # A third mission whose name merely looks alike is nobody's relation.
    mission(realm, "pj-pol", "workplan-collect-more", "pol", tasks=0, at=NOW - 3000)
    mirror, room = room_over(realm)
    pol = room.project("pj-pol", now=NOW)["project"]
    by = {m["anchor"]: m for m in pol["missions"]}
    retired = by[old]
    assert retired["topic"] == f"retired-workplan-collect-m{old}" and retired["resolved"] and retired["work"]["state"] == "replaced"
    assert retired["replaced_by"] == new and retired["task_counts"]["total"] == 1
    assert retired["tasks"][0]["origins"][0]["topic"] == "workplan-collect"  # the note names the old name; identity is the id
    replacement = by[new]
    assert replacement["topic"] == "workplan-collect" and not replacement["resolved"]
    assert replacement["replaces"] == old and replacement["replaced_by"] is None
    assert replacement["task_counts"]["total"] == 0  # the old mission's task is not handed to the new one by name
    third = next(m for m in pol["missions"] if m["topic"] == "workplan-collect-more")
    assert third["replaces"] is None and third["replaced_by"] is None
    assert pol["counts"]["missions_by_state"] == {"planned": 2, "replaced": 1} and pol["counts"]["open_missions"] == 2
    assert room.locate_work(old)["kind"] == MISSION and room.locate_work(new)["read"].topic == "workplan-collect"
    assert room.locate_work(retired["tasks"][0]["anchor"])["kind"] == TASK
    assert room.locate_work("nope") is None and room.locate_work(1) is None


def test_missing_parents_and_documents_are_shown_as_gaps_never_filled_in():
    realm = world()
    realm.add_channel(70, "pj-papers", folder_id=7, description="[AUTO] autolab project: papers (main-only routine project)")
    # A task whose mission conversation is gone (its channel was deleted with it).
    realm.add_channel(400, "work-m9999", folder_id=7)
    bot(realm, "work-m9999", "workrun-task1-m9999", "[selfnote][task] 9999#1", at=NOW - 3000)
    bot(realm, "work-m9999", "workrun-task1-m9999", "# Orphan task", at=NOW - 3000)
    # A mission with no [doc] note at all, and a setup topic that carries a mission (the older way).
    dev(realm, "pj-papers", "workplan-nodoc", "Mission: no doc", at=NOW - 2000)
    bot(realm, "pj-papers", "workplan-nodoc", "[selfnote][mission] papers", at=NOW - 1990)
    bot(realm, "pj-papers", "workplan-nodoc", "@**Developer**\n\nPlanned.", at=NOW - 1980)
    setup, _, _ = mission(realm, "pj-papers", "workplan-setup-papers-workspace", "papers", tasks=1, work_stream=401, at=NOW - 4000)
    mirror, room = room_over(realm)
    papers = room.project("pj-papers", now=NOW)["project"]
    assert papers["kind"] == "unknown"
    (orphan,) = papers["orphan_tasks"]
    assert orphan["mission"] == 9999 and orphan["label"] == "m9999#1" and orphan["document"] is None
    assert papers["counts"]["orphan_tasks"] == 1
    nodoc = next(m for m in papers["missions"] if m["topic"] == "workplan-nodoc")
    assert nodoc["document"] is None and {g["kind"] for g in nodoc["gaps"]} == {"no-document", "tasks-unknown"}
    setup_mission = next(m for m in papers["missions"] if m["anchor"] == setup)
    assert setup_mission["setup"] is True and setup_mission["task_counts"]["total"] == 1
    assert papers["setups"] == []  # the setup conversation is the mission row, not a second row
    assert [g["kind"] for g in papers["gaps"]] == ["no-document"]
    assert room.project("pj-nowhere", now=NOW)["error"].startswith("no project channel")
    assert room.locate_work(orphan["anchor"])["project_id"] == 70 and room.locate_work(orphan["anchor"])["mission"] is None


def test_resolved_history_stays_readable_and_an_archived_project_is_listed_with_nothing_invented():
    realm = world()
    realm.add_channel(79, "pj-gh", folder_id=5, description="autolab project: gh (study pattern)")
    done, _, tasks = mission(realm, "pj-gh", "workplan-t1", "gh", tasks=1, work_stream=500, at=NOW - 9000)
    bot(realm, f"work-m{done}", f"workrun-task1-m{done}", "[selfnote][state] completed", at=NOW - 8000)
    dev(realm, "pj-gh", "workplan-t1", "[selfnote][state] done", at=NOW - 7000)
    realm.resolve("pj-gh", "workplan-t1")
    realm.resolve(f"work-m{done}", f"workrun-task1-m{done}")
    # Resolved with nothing recorded about the end: said, not repaired.
    unfinished, _, _ = mission(realm, "pj-gh", "workplan-t2", "gh", tasks=0, at=NOW - 6000)
    realm.resolve("pj-gh", "workplan-t2")
    realm.add_channel(23, "pj-ancient", archived=True, description="asset_pipeline1 p1 end-to-end check")
    mirror, room = room_over(realm)
    board = room.board(now=NOW)
    assert board["counts"] == {"projects": 2, "live": 1, "archived": 1}
    ancient = next(r for r in board["projects"] if r["channel"] == "pj-ancient")
    assert ancient["archived"] and ancient["kind"] == "unknown" and ancient["counts"]["missions"] == 0
    assert [g["kind"] for g in ancient["gaps"]] == ["archived"] and ancient["reply"] == {"state": "unknown"}
    assert ancient["tasks_read"]["complete"] is False
    gh = room.project("pj-gh", now=NOW)["project"]
    first = next(m for m in gh["missions"] if m["anchor"] == done)
    assert first["resolved"] and first["live_topic"] == "✔ workplan-t1" and first["work"]["state"] == "done"
    assert first["work"]["note"] == "marked done by whoever accepted it"
    assert first["reply"]["state"] == "done" and first["tasks"][0]["resolved"] and first["tasks"][0]["state"] == "completed"
    assert first["gaps"] == [] and first["zulip_url"].endswith("/topic/%E2%9C%94%20workplan-t1")
    second = next(m for m in gh["missions"] if m["anchor"] == unfinished)
    assert second["resolved"] and second["work"]["state"] == "planned"
    assert {g["kind"] for g in second["gaps"]} == {"resolved-unfinished", "tasks-unknown"}
    assert gh["counts"]["open_missions"] == 0 and gh["counts"]["missions_by_state"] == {"done": 1, "planned": 1}


def test_a_stale_mirror_makes_every_reply_state_unknown_and_keeps_the_last_known_one():
    realm = world()
    realm.add_channel(93, "pj-media", folder_id=6, description="autolab project: media (study pattern)")
    mission(realm, "pj-media", "workplan-one", "media", tasks=0)
    dev(realm, "pj-media", "workplan-one", "And now?", at=NOW - 100)
    mirror, room = room_over(realm)
    before = room.project("pj-media", now=NOW)
    assert before["stale"] is False and before["project"]["missions"][0]["reply"]["state"] == "awaiting"
    mirror._set_stale("event queue expired; resyncing")
    after = room.project("pj-media", now=NOW)
    assert after["stale"] is True and after["health"]["state"] == "stale"
    reply = after["project"]["missions"][0]["reply"]
    assert reply["state"] == "unknown" and reply["stale_state"] == "awaiting"
    assert after["project"]["missions"][0]["work"]["state"] == "planned"  # the record is the record
    assert room.board(now=NOW)["stale"] is True


def test_without_an_ops_engine_the_reply_state_is_unknown_not_quiet():
    realm = world()
    realm.add_channel(93, "pj-media", folder_id=6, description="x")
    mission(realm, "pj-media", "workplan-one", "media", tasks=0)
    mirror = mirror_over(realm)
    room = ProjectRoom(mirror=mirror, ops=None)
    found = room.project("pj-media", now=NOW)["project"]["missions"][0]["reply"]
    assert found["state"] == "unknown" and "not configured" in found["evidence"]
    assert ProjectRoom(mirror=None).board(now=NOW)["projects"] == []
    assert ProjectRoom(mirror=None).project("x")["error"].startswith("no mirror")


def test_repeated_reads_cost_no_zulip_call_and_a_new_post_reaches_the_next_read():
    realm = world()
    realm.add_channel(170, "pj-garden", folder_id=19, description="[AUTO] project: garden; project; opened from argue argue/argue-g")
    mission(realm, "pj-garden", "workplan-one", "garden", tasks=1, work_stream=600)
    mirror, room = room_over(realm)
    before = realm.calls
    for _ in range(3):
        room.board(now=NOW)
        room.project("pj-garden", now=NOW)
    assert realm.calls == before
    assert room.project("pj-garden", now=NOW)["project"]["missions"][0]["task_counts"]["finished"] == 0
    anchor = room.project("pj-garden", now=NOW)["project"]["missions"][0]["anchor"]
    bot(realm, f"work-m{anchor}", f"workrun-task1-m{anchor}", "[selfnote][state] completed", at=NOW - 10)
    pump(mirror)  # the event poll is the one call; the reads below make none
    after = realm.calls
    assert room.project("pj-garden", now=NOW)["project"]["missions"][0]["task_counts"]["finished"] == 1
    assert room.board(now=NOW)["projects"][0]["missions"][0]["task_counts"]["finished"] == 1
    assert realm.calls == after


def test_the_routes_answer_the_board_and_one_project_and_say_when_unconfigured():
    realm = world()
    realm.add_channel(170, "pj-garden", folder_id=19, description="[AUTO] project: garden; project; opened from argue argue/argue-g")
    front(realm, "pj-garden", "goal", "# Garden")
    mirror, room = room_over(realm)
    server = build_server("127.0.0.1", 0, Room(mirror=mirror), projects=room)
    import threading
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        def get(path):
            connection = HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            connection.request("GET", path)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        status, board = get("/projects")
        assert status == 200 and board["schema"] == "ag.projectroom.v1" and board["projects"][0]["channel"] == "pj-garden"
        status, detail = get("/projects/170")
        assert status == 200 and detail["project"]["documents"][0]["current"]["content"] == "# Garden"
        status, detail = get("/projects/pj-garden")
        assert status == 200 and detail["project"]["key"] == "170"
        status, missing = get("/projects/pj-none")
        assert status == 404 and "no project channel" in missing["error"]
        assert "/projects" in get("/")[1]["routes"]
    finally:
        server.shutdown()
        server.server_close()
    bare = build_server("127.0.0.1", 0, Room(mirror=mirror))
    thread = threading.Thread(target=bare.serve_forever, daemon=True)
    thread.start()
    try:
        connection = HTTPConnection("127.0.0.1", bare.server_address[1], timeout=5)
        connection.request("GET", "/projects")
        response = connection.getresponse()
        assert response.status == 503 and "not configured" in json.loads(response.read())["error"]
    finally:
        bare.shutdown()
        bare.server_close()
