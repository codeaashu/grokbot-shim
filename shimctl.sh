#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT/scripts/load-env.sh"
PIDFILE="$ROOT/state/shim.pid"

mkdir -p "$ROOT/logs" "$ROOT/state"

is_up() { curl -sk --max-time 2 https://localhost:8443/health >/dev/null 2>&1; }
container_mode() { [[ "$(uname -s)" == "Darwin" && -n "${GROKBOT_RUNTIME_DIR:-}" ]]; }

stop() {
  if container_mode; then
    docker exec "${GROKBOT_COMPUTER_CONTAINER:-grokbot-computer}" pkill -f '/grokbot-shim/shim/server.mjs' 2>/dev/null || true
    for _ in $(seq 1 20); do is_up || break; sleep 0.25; done
    return
  fi
  local pid=""
  if [ -f "$PIDFILE" ]; then
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  fi
  # Compatibility with shim processes started before the pidfile existed. The
  # anchored command line cannot match this script or its calling shell.
  for pid in $(pgrep -f "^node $ROOT/shim/server\.mjs$" || true); do
    kill "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 20); do is_up || break; sleep 0.25; done
  rm -f "$PIDFILE"
}

start() {
  if container_mode; then
    docker exec -d \
      -u "$(id -u):$(id -g)" \
      -w /grokbot-shim \
      -e ELECTRON_RUN_AS_NODE=1 \
      -e BIND_HOST=0.0.0.0 \
      -e CODEX_AUTH_FILE=/codex/auth.json \
      "${GROKBOT_COMPUTER_CONTAINER:-grokbot-computer}" \
      "${GROKBOT_HOST_APP:-/opt/Grok Bot/sand}" /grokbot-shim/shim/server.mjs
    for _ in $(seq 1 20); do is_up && break; sleep 0.25; done
    if is_up; then echo "shim up on https://localhost:8443"; else echo "shim FAILED to start; inspect container logs" >&2; exit 1; fi
    return
  fi
  (setsid node "$ROOT/shim/server.mjs" >>"$ROOT/logs/shim.out" 2>&1 < /dev/null & echo $! >"$PIDFILE")
  for _ in $(seq 1 20); do is_up && break; sleep 0.25; done
  if is_up; then echo "shim up on https://localhost:8443"; else echo "shim FAILED to start; tail $ROOT/logs/shim.out" >&2; exit 1; fi
}

case "${1:-restart}" in
  start) start ;;
  stop) stop; echo "shim stopped" ;;
  restart) stop; start ;;
  status) is_up && echo "up" || echo "down" ;;
esac
