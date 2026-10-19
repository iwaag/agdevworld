#!/bin/sh
# Builds and installs the Slack integration (integrations/slack, slack_connect
# p1) from one agdevworld commit, apart from the WFE release: restarting it
# never touches WFE, its workers or their runs.
#
#   scripts/slack-release.sh build    <area> [<commit>]  build and check a release (default HEAD)
#   scripts/slack-release.sh activate <area> <commit>    make a built release current and restart
#   scripts/slack-release.sh deploy   <area> [<commit>]  build, then activate
#   scripts/slack-release.sh status   <area>             current release and the service's own status
#
# <area> is the operating area (pj-agdev/.local/agdev). Layout:
#
#   <area>/slack/config.json                  tokens, Developer, WFE and link bases (ignored, mode 600)
#   <area>/slack/slack.sqlite                 the transport store (inbox, outbox, threads)
#   <area>/slack/releases/<commit>/           integrations/slack at that commit, npm ci + check, RELEASE.json
#   <area>/slack/current -> releases/<commit> what launchd (com.agdev.slack-front) runs
#
# Activation restarts the launchd job and requires the service to record a new
# pid and a Slack connection within the timeout; it never restores an older
# release on failure (activate one explicitly).
#
# Environment: SLACK_SERVICE_LABEL (default com.agdev.slack-front), SLACK_HEALTH_SECONDS (45).
set -eu

usage() { sed -n '6,9p' "$0" | sed 's/^# //' >&2; exit 2; }
[ $# -ge 2 ] || usage
CMD=$1
AREA=$(cd "$2" && pwd)
REPO=$(cd "$(dirname "$0")/.." && pwd)
LABEL=${SLACK_SERVICE_LABEL:-com.agdev.slack-front}
HEALTH=${SLACK_HEALTH_SECONDS:-45}
HOME_DIR="$AREA/slack"
NODE=$(command -v node)

resolve_commit() { git -C "$REPO" rev-parse --verify "${1:-HEAD}^{commit}"; }
cli() { SLACK_FRONT_CONFIG="$HOME_DIR/config.json" "$NODE" "$HOME_DIR/current/src/main.ts" "$@"; }

build() {
  SHA=$(resolve_commit "${1:-HEAD}")
  REL="$HOME_DIR/releases/$SHA"
  if [ -n "$(git -C "$REPO" status --porcelain -- integrations/slack)" ]; then
    echo "note: integrations/slack/ has uncommitted changes; the release is built from commit $SHA, not the working tree"
  fi
  git -C "$REPO" cat-file -e "$SHA:integrations/slack/package.json" 2>/dev/null || { echo "commit $SHA has no integrations/slack/" >&2; exit 1; }
  if [ -f "$REL/RELEASE.json" ]; then echo "release $SHA exists (built and checked before)"; return 0; fi
  rm -rf "$REL.tmp" && mkdir -p "$REL.tmp"
  git -C "$REPO" archive "$SHA" integrations/slack | tar -x -C "$REL.tmp" --strip-components 2
  ( cd "$REL.tmp" && npm ci --no-audit --no-fund && npm run check ) || { echo "build or check failed; nothing in use changed ($REL.tmp kept for inspection)" >&2; exit 1; }
  printf '{"agdevworld": "%s", "tree": "%s", "built": "%s"}\n' "$SHA" "$(git -C "$REPO" rev-parse "$SHA:integrations/slack")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$REL.tmp/RELEASE.json"
  mv "$REL.tmp" "$REL"
  echo "built and checked: slack/releases/$SHA"
}

activate() {
  SHA=$(resolve_commit "$1")
  [ -f "$HOME_DIR/releases/$SHA/RELEASE.json" ] || { echo "release $SHA is not built" >&2; exit 1; }
  BEFORE=$(cli status --json 2>/dev/null | sed -n 's/.*"pid": "\([0-9]*\)".*/\1/p' || true)
  ln -sfn "releases/$SHA" "$HOME_DIR/current.tmp" && mv -fh "$HOME_DIR/current.tmp" "$HOME_DIR/current"
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
  i=0
  while [ $i -lt "$HEALTH" ]; do
    ST=$(cli status --json 2>/dev/null || true)
    PID=$(printf '%s' "$ST" | sed -n 's/.*"pid": "\([0-9]*\)".*/\1/p')
    CONN=$(printf '%s' "$ST" | sed -n 's/.*"connection": "\([a-z]*\)".*/\1/p')
    if [ -n "$PID" ] && [ "$PID" != "$BEFORE" ] && [ "$CONN" = connected ]; then echo "active: $SHA (pid $PID, Slack connected)"; return 0; fi
    sleep 1; i=$((i + 1))
  done
  echo "activated $SHA but the service did not report a new connection within ${HEALTH}s; see $HOME_DIR/service.log and 'slack-release.sh status'" >&2
  exit 1
}

case "$CMD" in
  build) build "${3:-HEAD}" ;;
  activate) [ $# -ge 3 ] || usage; activate "$3" ;;
  deploy) build "${3:-HEAD}"; activate "$(resolve_commit "${3:-HEAD}")" ;;
  status)
    echo "current: $(readlink "$HOME_DIR/current" 2>/dev/null || echo none)"
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | sed -n 's/^\t\(state\|pid\|last exit code\) = /\1: /p' || echo "launchd: $LABEL not loaded"
    cli status ;;
  *) usage ;;
esac
