#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT/scripts/load-env.sh"
GROKBOT_APP="${GROKBOT_APP:-/opt/Grok Bot/sand}"

export SAND_BACKEND_URL="${SAND_BACKEND_URL:-https://localhost:8443}"
export NODE_EXTRA_CA_CERTS="$ROOT/certs/rootCA.pem"
export SAND_DEV_LOGIN="${SAND_DEV_LOGIN:-Ultra}"
export SAND_DEV_LOGIN_EMAIL="${SAND_DEV_LOGIN_EMAIL:-shim@local}"
export SAND_HOST_GATEWAY_URL="${SAND_HOST_GATEWAY_URL:-http://localhost:8550}"
export SAND_HOST_GATEWAY_TOKEN="${SAND_HOST_GATEWAY_TOKEN:-shim-gateway-token}"

mkdir -p "$ROOT/appdata" "$ROOT/logs"

if [[ ! -x "$GROKBOT_APP" ]]; then
  echo "Grok Bot executable not found: $GROKBOT_APP" >&2
  exit 1
fi

if ! curl -sk --max-time 2 "$SAND_BACKEND_URL/health" >/dev/null 2>&1; then
  nohup node "$ROOT/shim/server.mjs" >>"$ROOT/logs/shim.out" 2>&1 &
  echo "started shim (pid $!), log: $ROOT/logs/shim.out"
  sleep 1
else
  echo "shim already running on $SAND_BACKEND_URL"
fi

echo "backend: $SAND_BACKEND_URL  dev-login: $SAND_DEV_LOGIN ($SAND_DEV_LOGIN_EMAIL)"
echo "NOTE: using isolated user-data-dir at $ROOT/appdata (real login untouched)"
# --no-sandbox has to be on the command line for the Computer preview to draw.
# The preview is a <webview> on the box's noVNC page and the app marks that guest
# sandboxed, but the app's own in-process no-sandbox switch lands too late for it,
# so the guest starts half-sandboxed: its shared-memory allocations fail (ESRCH),
# the renderer aborts on /dev/shm, and the panel stays blank.
exec "$GROKBOT_APP" --no-sandbox --user-data-dir="$ROOT/appdata" "$@"
