#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT/scripts/load-env.sh"
GROKBOT_APP="${GROKBOT_APP:-/opt/Grok Bot/sand}"

export SAND_BACKEND_URL="${SAND_BACKEND_URL:-https://localhost:8443}"
export NODE_EXTRA_CA_CERTS="$ROOT/certs/rootCA.pem"
export SAND_HOST_PORT="${SAND_HOST_PORT:-8550}"
export SAND_GATEWAY_BIND_HOST="${SAND_GATEWAY_BIND_HOST:-127.0.0.1}"
export SAND_GATEWAY_TOKEN="${SAND_GATEWAY_TOKEN:-shim-gateway-token}"
export SAND_DEV_INFERENCE_TOKEN_FILE="$ROOT/state/host-token.json"
export SAND_HOST_LOG_FILE="${SAND_HOST_LOG_FILE:-$ROOT/logs/host.log}"
export SAND_BOX_MAX_WINDOWS="${SAND_BOX_MAX_WINDOWS:-1}"
export ELECTRON_RUN_AS_NODE=1

mkdir -p "$ROOT/state/host-workdir"
cd "$ROOT/state/host-workdir"

if [[ ! -x "$GROKBOT_APP" ]]; then
  echo "Grok Bot executable not found: $GROKBOT_APP" >&2
  exit 1
fi
if [[ ! -f "$ROOT/host/dist/host/host-main.cjs" ]]; then
  echo "host runtime is missing; run: npm run setup" >&2
  exit 1
fi

if ! curl -sk --max-time 2 "$SAND_BACKEND_URL/health" >/dev/null 2>&1; then
  echo "backend shim not running on $SAND_BACKEND_URL — start it: node $ROOT/shim/server.mjs" >&2
  exit 1
fi

echo "host gateway: http://$SAND_GATEWAY_BIND_HOST:$SAND_HOST_PORT (token: $SAND_GATEWAY_TOKEN)"
echo "backend: $SAND_BACKEND_URL  token-file: $SAND_DEV_INFERENCE_TOKEN_FILE"
exec "$GROKBOT_APP" "$ROOT/host/dist/host/host-main.cjs" "$@"
