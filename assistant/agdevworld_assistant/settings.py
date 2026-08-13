"""Paths and environment-derived settings shared by the service modules."""

import os
import sys
from pathlib import Path

ASSISTANT_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = ASSISTANT_DIR.parent

GUIDE_PATH = ASSISTANT_DIR / "GUIDE.md"
AGENTS_CONFIG = PROJECT_ROOT / "agents.toml"
AGENTS_LOCAL_CONFIG = PROJECT_ROOT / ".local" / "agents.local.toml"

# Records outlive the container; the compose volume is mounted at /records.
RECORDS_DIR = Path(
    os.environ.get("ASSISTANT_RECORDS_DIR") or PROJECT_ROOT / ".local" / "assistant-records"
)

# The harness bound stays below nginx's 310 s read timeout so the browser
# receives this service's own timeout record rather than a proxy error.
# run_harness takes seconds; the deployment variable has always been in ms.
AGENT_TIMEOUT_SECONDS = int(os.environ.get("AGDEVWORLD_AGENT_TIMEOUT_MS") or 300_000) / 1000

TOOL_BASE_URL = os.environ.get("AGDEVWORLD_TOOL_BASE_URL") or "http://127.0.0.1:8090"

NO_GUIDE = "No capability card is installed on this assistant."


def read_guide() -> str:
    """The entrance guide, from disk, now.

    Per request rather than at boot (the cagent llms.txt pattern): editing the
    card changes the next answer without a restart. An unreadable card leaves
    the assistant without a card, which is not a server error.
    """
    try:
        return GUIDE_PATH.read_text(encoding="utf-8")
    except OSError as error:
        print(f"capability card unreadable: {error}", file=sys.stderr, flush=True)
        return NO_GUIDE
