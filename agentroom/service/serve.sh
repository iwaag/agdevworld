#!/bin/sh
# Run the agent room relay from a checkout, the way agforge's service script
# does: resolve the project directory, then hand off to uv.
#
#   AGENTROOM_ZULIP_ENV=<path to a zulip .env> service/serve.sh
#
# The credentials file is never in the repo; on agstudio it is one of
# pj-agdev/.local/zulip/*.env (see that project's ignored devenv.md).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"
exec uv run --project . python -m agentroom.main "$@"
