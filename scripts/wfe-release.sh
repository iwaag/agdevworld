#!/bin/sh
# Builds, installs and recovers the workflow editor service and its `wfe`
# launcher from agdevworld's own source (workflow_editor/, p4/ex1). The editor
# is a system component of agdevworld: a release is built from one agdevworld
# commit and nothing is fetched from any managed project.
#
#   scripts/wfe-release.sh build    <area> [<commit>]  build and check a release (default HEAD)
#   scripts/wfe-release.sh activate <area> <commit>    make a built release current
#   scripts/wfe-release.sh deploy   <area> [<commit>]  build, then activate
#   scripts/wfe-release.sh rollback <area>             activate the release that was current before
#   scripts/wfe-release.sh status   <area>             current/previous releases, service and launcher
#
# <area> is the operating area (pj-agdev/.local/agdev): its registry.json is the
# catalog, and it holds the installed system code beside the workspaces:
#
#   <area>/service/releases/<agdevworld commit>/   workflow_editor/ at that commit, built and checked, RELEASE.json
#   <area>/service/current -> releases/<commit>    what the service (launchd) and the launcher run
#   <area>/service/previous                        the release current before the last activation
#   <area>/bin/wfe                                 the launcher (autolab's executor and its agents use it)
#
# The service and the launcher both run service/current, so one symlink switch
# moves them together, and a restore moves them back together. Activation
# refuses while an execution attempt is open (the CLI is not replaced under a
# live attempt), restarts com.agdev.wfe-service, and then requires both the
# service (GET api/version) and the launcher (wfe version) to report the new
# commit. If either does not within the timeout, the previous release is
# restored and the service restarted on it.
#
# Environment (tests): WFE_SERVICE_LABEL (default com.agdev.wfe-service),
# WFE_SERVICE_URL (default http://127.0.0.1:8098), WFE_HEALTH_SECONDS (30).
set -eu

usage() { sed -n '7,11p' "$0" | sed 's/^# //' >&2; exit 2; }
[ $# -ge 2 ] || usage
CMD=$1
AREA=$(cd "$2" && pwd)
REPO=$(cd "$(dirname "$0")/.." && pwd)
LABEL=${WFE_SERVICE_LABEL:-com.agdev.wfe-service}
URL=${WFE_SERVICE_URL:-http://127.0.0.1:8098}
HEALTH=${WFE_HEALTH_SECONDS:-30}
SERVICE="$AREA/service"
[ -f "$AREA/registry.json" ] || { echo "$AREA has no registry.json: not an operating area" >&2; exit 2; }

resolve_commit() { git -C "$REPO" rev-parse --verify "${1:-HEAD}^{commit}"; }

build() {
  SHA=$(resolve_commit "${1:-HEAD}")
  REL="$SERVICE/releases/$SHA"
  if [ -n "$(git -C "$REPO" status --porcelain -- workflow_editor)" ]; then
    echo "note: workflow_editor/ has uncommitted changes; the release is built from commit $SHA, not the working tree"
  fi
  git -C "$REPO" cat-file -e "$SHA:workflow_editor/package.json" 2>/dev/null || { echo "commit $SHA has no workflow_editor/" >&2; exit 1; }
  if [ -f "$REL/RELEASE.json" ]; then echo "release $SHA exists (built and checked before)"; return 0; fi
  rm -rf "$REL.tmp" && mkdir -p "$REL.tmp"
  git -C "$REPO" archive "$SHA" workflow_editor | tar -x -C "$REL.tmp" --strip-components 1
  ( cd "$REL.tmp" && npm ci --no-audit --no-fund && npm run check ) || { echo "build or check failed; nothing in use changed ($REL.tmp kept for inspection)" >&2; exit 1; }
  printf '{"agdevworld": "%s", "tree": "%s", "built": "%s"}\n' "$SHA" "$(git -C "$REPO" rev-parse "$SHA:workflow_editor")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$REL.tmp/RELEASE.json"
  mv "$REL.tmp" "$REL"
  echo "built and checked: releases/$SHA"
}

open_attempts() {
  DB="$AREA/.local/exec/exec.sqlite"
  [ -f "$DB" ] || return 0
  sqlite3 -readonly "$DB" "SELECT id || ' (' || workspace || ' ' || workflow || '/' || run || ')' FROM attempts WHERE state != 'ended'" 2>/dev/null || true
}

write_launcher() {
  mkdir -p "$AREA/bin"
  cat > "$AREA/bin/wfe.new" <<SH
#!/bin/sh
# wfe of the installed release (service/current), pinned to this area's registry
# and to the port its service listens on (so `wfe status` finds it).
# Written by agdevworld scripts/wfe-release.sh; the service runs the same release.
WFE_REGISTRY="$AREA/registry.json" WFE_PORT="${URL##*:}" exec node "$SERVICE/current/cli/wfe.ts" "\$@"
SH
  chmod +x "$AREA/bin/wfe.new" && mv -f "$AREA/bin/wfe.new" "$AREA/bin/wfe"
}

switch_to() { ln -sfn "releases/$1" "$SERVICE/current.new" && mv -fh "$SERVICE/current.new" "$SERVICE/current"; }

restart() {
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/$LABEL" && echo "restarted $LABEL"
  else
    echo "$LABEL is not loaded; nothing restarted"
  fi
}

# healthy <sha>: the service and the launcher both run that release. A release
# from before RELEASE.json existed (rollback target only) is accepted when the
# service answers its dashboard.
healthy() {
  i=0
  while [ "$i" -lt "$HEALTH" ]; do
    if [ -f "$SERVICE/releases/$1/RELEASE.json" ]; then
      svc=$(curl -sf "$URL/api/version" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).release?.agdevworld??"")}catch{console.log("")}})' || true)
      cli=$("$AREA/bin/wfe" version --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).release?.agdevworld??"")}catch{console.log("")}})' || true)
      [ "$svc" = "$1" ] && [ "$cli" = "$1" ] && return 0
    else
      curl -sf -o /dev/null "$URL/api/agdev" 2>/dev/null && return 0
    fi
    i=$((i + 1)); sleep 1
  done
  return 1
}

activate() {
  SHA=$(resolve_commit "$1")
  [ -f "$SERVICE/releases/$SHA/RELEASE.json" ] || { echo "releases/$SHA is not built (scripts/wfe-release.sh build)" >&2; exit 1; }
  busy=$(open_attempts)
  if [ -n "$busy" ]; then echo "refused: an execution attempt is open: $busy. Let it end (or stop it) before replacing the CLI." >&2; exit 1; fi
  PREV=$(readlink "$SERVICE/current" 2>/dev/null | sed 's#^releases/##' || true)
  if [ "$PREV" = "$SHA" ]; then echo "releases/$SHA is already current"; write_launcher; restart; healthy "$SHA" && echo "healthy" && return 0; echo "not healthy" >&2; exit 1; fi
  switch_to "$SHA"
  write_launcher
  echo "current: releases/$SHA (was: ${PREV:-none})"
  restart
  if healthy "$SHA"; then
    [ -n "$PREV" ] && printf '%s\n' "$PREV" > "$SERVICE/previous"
    echo "healthy: the service and bin/wfe run agdevworld $SHA"
    return 0
  fi
  echo "health check failed for $SHA within ${HEALTH}s" >&2
  if [ -n "$PREV" ]; then
    switch_to "$PREV"; write_launcher; restart
    if healthy "$PREV"; then echo "restored releases/$PREV (service and launcher)" >&2; else echo "restored releases/$PREV, but it is not healthy either: inspect $AREA/service.log" >&2; fi
  fi
  exit 1
}

case "$CMD" in
  build) build "${3:-HEAD}" ;;
  activate) [ $# -ge 3 ] || usage; activate "$3" ;;
  deploy) build "${3:-HEAD}"; activate "$(resolve_commit "${3:-HEAD}")" ;;
  rollback)
    [ -f "$SERVICE/previous" ] || { echo "no previous release recorded" >&2; exit 1; }
    P=$(cat "$SERVICE/previous")
    [ -d "$SERVICE/releases/$P" ] || { echo "previous release $P is not present" >&2; exit 1; }
    busy=$(open_attempts); [ -z "$busy" ] || { echo "refused: an execution attempt is open: $busy" >&2; exit 1; }
    CUR=$(readlink "$SERVICE/current" | sed 's#^releases/##')
    switch_to "$P"; write_launcher; restart
    if healthy "$P"; then printf '%s\n' "$CUR" > "$SERVICE/previous"; echo "rolled back to releases/$P (previous is now $CUR)"; else echo "releases/$P is not healthy; inspect $AREA/service.log" >&2; exit 1; fi ;;
  status)
    echo "current:  $(readlink "$SERVICE/current" 2>/dev/null || echo none)"
    echo "previous: $(cat "$SERVICE/previous" 2>/dev/null || echo none)"
    echo "releases: $(ls "$SERVICE/releases" 2>/dev/null | tr '\n' ' ')"
    echo "service:  $(curl -sf "$URL/api/version" 2>/dev/null || echo "no answer at $URL/api/version")"
    echo "launcher: $("$AREA/bin/wfe" version --json 2>/dev/null | tr -d '\n' || echo "no launcher")"
    a=$(open_attempts); echo "open attempts: ${a:-none}" ;;
  *) usage ;;
esac
