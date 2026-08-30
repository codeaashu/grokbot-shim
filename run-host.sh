#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT/scripts/load-env.sh"
GROKBOT_APP="${GROKBOT_APP:-/opt/Grok Bot/sand}"
GROKBOT_HOST_APP="${GROKBOT_HOST_APP:-$GROKBOT_APP}"

export SAND_BACKEND_URL="${SAND_BACKEND_URL:-https://localhost:8443}"
export NODE_EXTRA_CA_CERTS="$ROOT/certs/rootCA.pem"
export SAND_HOST_PORT="${SAND_HOST_PORT:-8550}"
export SAND_GATEWAY_BIND_HOST="${SAND_GATEWAY_BIND_HOST:-127.0.0.1}"
export SAND_GATEWAY_TOKEN="${SAND_GATEWAY_TOKEN:-shim-gateway-token}"
export SAND_DEV_INFERENCE_TOKEN_FILE="$ROOT/state/host-token.json"
export SAND_HOST_LOG_FILE="${SAND_HOST_LOG_FILE:-$ROOT/logs/host.log}"
export SAND_BOX_MAX_WINDOWS="${SAND_BOX_MAX_WINDOWS:-1}"
export ELECTRON_RUN_AS_NODE=1

mkdir -p "$ROOT/state/home" "$ROOT/state/host-workdir"
cd "$ROOT/state/host-workdir"

if [[ "${1:-}" == "--stop" ]]; then
  if [[ "$(uname -s)" == "Darwin" && -n "${GROKBOT_RUNTIME_DIR:-}" ]]; then
    docker exec "${GROKBOT_COMPUTER_CONTAINER:-grokbot-computer}" \
      pkill -f '/grokbot-shim/host/dist/host/host-main.cjs' 2>/dev/null || true
  fi
  exit 0
fi

if [[ "$(uname -s)" == "Darwin" && -n "${GROKBOT_RUNTIME_DIR:-}" ]]; then
  CONTAINER="${GROKBOT_COMPUTER_CONTAINER:-grokbot-computer}"
  exec docker exec \
    -u "$(id -u):$(id -g)" \
    -w /grokbot-shim/state/host-workdir \
    -e HOME=/grokbot-shim/state/home \
    -e ELECTRON_RUN_AS_NODE=1 \
    -e NODE_EXTRA_CA_CERTS=/grokbot-shim/certs/rootCA.pem \
    -e SAND_BACKEND_URL=https://localhost:8443 \
    -e SAND_HOST_PORT="$SAND_HOST_PORT" \
    -e SAND_GATEWAY_BIND_HOST=0.0.0.0 \
    -e SAND_GATEWAY_TOKEN="$SAND_GATEWAY_TOKEN" \
    -e SAND_DEV_INFERENCE_TOKEN_FILE=/grokbot-shim/state/host-token.json \
    -e SAND_HOST_LOG_FILE=/grokbot-shim/logs/host.log \
    -e SAND_BOX_MAX_WINDOWS="$SAND_BOX_MAX_WINDOWS" \
    "$CONTAINER" "$GROKBOT_HOST_APP" /grokbot-shim/host/dist/host/host-main.cjs "$@"
fi

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
