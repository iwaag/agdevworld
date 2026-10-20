"""The Developer's write credential, for what the relay still writes.

Since retire_old_ui p1 the relay's own chat door (`POST /chat`, routine run
requests) is gone, as are the legacy Front Desk's and the Arguing Room's
posts (retired in project_migration p8). What is left is the credential the
completion door closes an argue with (`close.py`), its status for the
Arguing Room's payload, and the id it posts as.

`AGENTROOM_CHAT_ZULIP_ENV` is the Developer's, and nothing falls back to it or
from it: the mirror that reads never posts, and unset means the relay is
read-only and says so.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from agag.zulip import ZulipClient


#: The credential the chat writes with. Deliberately its own variable.
CHAT_ENV_VARIABLE = "AGENTROOM_CHAT_ZULIP_ENV"
#: The longest text a write may carry; reported in `status()`.
DEFAULT_MAX_CHARS = 4000

__all__ = ["CHAT_ENV_VARIABLE", "Chat", "DEFAULT_MAX_CHARS"]


@dataclass
class Chat:
    """The write half, with its own credential or none at all."""

    env_path: Path | None = None
    max_chars: int = DEFAULT_MAX_CHARS
    client_factory: Callable[[Path], ZulipClient] | None = None
    _client: ZulipClient | None = field(default=None, repr=False)

    @property
    def configured(self) -> bool:
        return self.env_path is not None

    def status(self) -> dict:
        return {
            "configured": self.configured,
            "max_chars": self.max_chars,
            "reason": None if self.configured else (
                f"{CHAT_ENV_VARIABLE} is unset, so this relay reads only"
            ),
        }

    def viewer_id(self) -> int | None:
        """The user id this credential posts as — who a request "for you"
        is for on screen. Asked once; None when unknown."""
        if not self.configured:
            return None
        if getattr(self, "_viewer", None) is None:
            try:
                self._viewer = int(self.client().whoami()["user_id"])
            except Exception:  # noqa: BLE001 - unknown viewer: nothing reads "for you"
                return None
        return self._viewer

    def client(self) -> ZulipClient:
        if self._client is None:
            factory = self.client_factory or ZulipClient.from_env
            self._client = factory(self.env_path)
        return self._client
