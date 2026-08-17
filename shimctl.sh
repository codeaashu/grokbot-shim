#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT/scripts/load-env.sh"
PIDFILE="$ROOT/state/shim.pid"

mkdir -p "$ROOT/logs" "$ROOT/state"

is_up() { curl -sk --max-time 2 https://localhost:8443/health >/dev/null 2>&1; }

stop() {
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
