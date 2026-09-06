"""Is a run happening *right now* — asked of the host, not of Zulip.

`operation_room` p1 step B measured every candidate for this and only one
survived: **a topic's generation directory with no run record newer than it.**
`serve_topic` builds `.local/topics/<channel>/<topic>/<N>/<role>/` and writes
`chatlog.md` into it *before* the harness starts; `write_run_record` files
`.local/agent/<role>/run-NNNN.json` only after it returns. So a workspace that
is newer than the newest record is a run that has not finished. It covered 99%
of agfront's 545 historical runs and named the channel, the topic, the
generation and the role while doing it.

Two things it is not:

- **It is not a Zulip signal**, which is the whole reason it is allowed to be
  polled at a few seconds. p1 measured HTTP 429 for a repeated realm sweep, and
  the event queue is already real-time — there is nothing to gain by asking
  Zulip more often and a quota to lose. Everything here is `stat`.
- **It is not global.** Only the agents of the *selected* session are looked
  at (plan step 4), and only ones whose workspace root this host actually has.
  An instance on another node has no directory here, and this says
  `known: false` rather than `idle` — the p2 rule that an absence is never
  rendered as quiet, applied to a filesystem instead of a realm.

The role names in the two trees are **different vocabularies** (p1: an
entrance serving builds `…/<N>/front/` and files its record under
`.local/agent/entrance_front/`), so the comparison is against the newest record
of *any* role, which is what "nothing has finished since" actually means.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

#: `instance=<path>` pairs, comma separated. Instances, not agents: the same
#: agent runs on more than one node and only this host's copy is here.
ROOTS_VARIABLE = "AGENTROOM_AGENT_ROOTS"
#: A generation directory is built just before the harness starts, and the
#: record is written just after it returns; p1 measured the gap at about five
#: seconds and found that widening it destroys attribution (agfront's
#: unambiguous rate fell from 94% to 38% at 120 s). This is the same slack,
#: used the other way round: a workspace within it of the newest record is not
#: yet evidence of anything.
SLACK_SECONDS = 5.0

__all__ = ["ROOTS_VARIABLE", "SLACK_SECONDS", "Inflight", "parse_roots"]


def parse_roots(value: str) -> dict[str, Path]:
    """`front-agstudio1=/path,autolab-agstudio1=/path` as a mapping.

    Absolute local paths, so they arrive in the environment and never in a
    tracked file (`devpolicy/styles.md`).
    """
    roots: dict[str, Path] = {}
    for entry in (value or "").split(","):
        instance, sep, path = entry.partition("=")
        if not sep or not instance.strip() or not path.strip():
            continue
        roots[instance.strip()] = Path(path.strip()).expanduser()
    return roots


def _newest(paths) -> float:
    newest = 0.0
    for path in paths:
        try:
            newest = max(newest, path.stat().st_mtime)
        except OSError:
            continue
    return newest


@dataclass
class Inflight:
    """The host's answer for one instance, or the reason there is none."""

    roots: dict[str, Path]

    def configured(self, instance: str) -> bool:
        return instance in self.roots

    def newest_record(self, root: Path) -> float:
        """When this agent last *finished* anything, of any role."""
        agent = root / ".local" / "agent"
        if not agent.is_dir():
            return 0.0
        newest = 0.0
        for role in agent.iterdir():
            if not role.is_dir():
                continue
            newest = max(newest, _newest(role.glob("run-*.json")))
        return newest

    def look(self, instance: str, channel: str, topic: str) -> dict:
        """Whether this instance has a run in flight for this conversation."""
        root = self.roots.get(instance)
        if root is None:
            return {
                "instance": instance, "channel": channel, "topic": topic,
                "known": False, "in_flight": None,
                "reason": f"no workspace root for {instance} on this host",
            }
        record = self.newest_record(root)
        workspace = root / ".local" / "topics" / channel / topic
        generations = [
            child for child in workspace.iterdir() if child.is_dir() and child.name.isdigit()
        ] if workspace.is_dir() else []
        if not generations:
            return {
                "instance": instance, "channel": channel, "topic": topic,
                "known": True, "in_flight": False, "generation": None,
                "reason": "this instance has never opened a workspace for this topic",
                "record_at": record or None,
            }
        newest = max(generations, key=lambda child: int(child.name))
        # The generation directory's own mtime moves when its role directory is
        # created, which is the moment the run begins.
        at = max(_newest(newest.iterdir()), newest.stat().st_mtime)
        running = at > record + SLACK_SECONDS
        return {
            "instance": instance, "channel": channel, "topic": topic,
            "known": True, "in_flight": running,
            "generation": int(newest.name),
            "workspace_at": at,
            "record_at": record or None,
            "reason": (
                f"generation {newest.name} is newer than every run record"
                if running else
                f"generation {newest.name} is older than the newest run record"
            ),
        }

    def busy(self, instance: str) -> dict:
        """Whether this instance is running *anything*, for any conversation.

        The topic-level answer above is the attributed one and this is the
        coarse one beside it, because a run that is not in a topic workspace
        (autolab's `coding` and `director` roles, forge's generator) leaves no
        directory the topic walk can see — p1 measured that as 100% of two
        roles. A screen that showed only the attributed signal would call an
        agent idle in exactly the case where it is busiest.
        """
        root = self.roots.get(instance)
        if root is None:
            return {"instance": instance, "known": False, "in_flight": None,
                    "reason": f"no workspace root for {instance} on this host"}
        record = self.newest_record(root)
        topics = root / ".local" / "topics"
        newest = 0.0
        where = None
        if topics.is_dir():
            for channel in topics.iterdir():
                if not channel.is_dir():
                    continue
                for topic in channel.iterdir():
                    if not topic.is_dir():
                        continue
                    at = _newest(child for child in topic.iterdir() if child.is_dir())
                    if at > newest:
                        newest, where = at, f"{channel.name}/{topic.name}"
        running = newest > record + SLACK_SECONDS
        return {
            "instance": instance, "known": True, "in_flight": running,
            "workspace_at": newest or None, "record_at": record or None,
            "where": where if running else None,
            "reason": (
                f"the newest workspace ({where}) is newer than every run record"
                if running else "every workspace this host has is older than a finished run"
            ),
        }
