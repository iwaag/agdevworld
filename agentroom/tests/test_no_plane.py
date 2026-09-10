"""The relay reaches no second system (`refactor` p2 step 4).

`AGENTROOM_PLANE_ENV` existed for the one record this room read outside
Zulip — forge's Plane Work — and forge's record is a conversation now. An
import-graph assertion, which is stronger than a rejecting client: the code
cannot call Plane because the module is never loaded.
"""

import subprocess
import sys

MODULES = ("agentroom.main", "agentroom.server", "agentroom.close",
           "agentroom.closing", "agentroom.ops", "agentroom.forge",
           "agentroom.autolab")


def test_no_relay_module_loads_the_plane_client():
    for name in MODULES:
        __import__(name)
    assert [module for module in sys.modules if module.startswith("agag.plane")] == []


def test_the_relay_loads_without_plane_in_a_fresh_interpreter():
    program = (
        "import importlib, sys;"
        f"[importlib.import_module(name) for name in {MODULES!r}];"
        "print([m for m in sys.modules if m.startswith('agag.plane')])"
    )
    result = subprocess.run([sys.executable, "-c", program],
                            capture_output=True, text=True, check=True)
    assert result.stdout.strip() == "[]"


def test_the_completion_door_has_no_plane_credential_to_configure():
    from agentroom import main
    from agentroom.close import Closer

    assert not any("PLANE" in name for name in dir(main))
    assert "plane" not in Closer.__dataclass_fields__
    door = Closer(topics=dict)
    assert "plane" not in door.status()
