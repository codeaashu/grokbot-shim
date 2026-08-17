#!/usr/bin/env bash
# One command for the whole stack: computer desktop, backend shim (:8443), and
# host gateway (:8550), then the desktop app in the foreground. A computer
# container that was already running is left alone on exit.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT/scripts/load-env.sh"

if [[ ! -s "$ROOT/host/dist/host/host-main.cjs" || ! -f "$ROOT/certs/localhost.pem" ]]; then
  echo "local runtime files are missing; run: npm run setup" >&2
  exit 1
fi

COMPUTER_WAS_RUNNING=0
if "$ROOT/computerctl.sh" status >/dev/null 2>&1; then
  COMPUTER_WAS_RUNNING=1
fi
HOST_WAS_RUNNING=0
if ss -ltn 2>/dev/null | grep -q '127.0.0.1:8550'; then
  HOST_WAS_RUNNING=1
fi
HOST_PID=""

cleanup() {
  [ -n "$HOST_PID" ] && kill "$HOST_PID" 2>/dev/null || true
  if [ "$HOST_WAS_RUNNING" -eq 0 ]; then
    "$ROOT/shimctl.sh" stop >/dev/null 2>&1 || true
  fi
  if [ "$COMPUTER_WAS_RUNNING" -eq 0 ]; then
    "$ROOT/computerctl.sh" stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

"$ROOT/computerctl.sh" start
"$ROOT/shimctl.sh" restart

if [ "$HOST_WAS_RUNNING" -eq 1 ]; then
  echo "host gateway already running on http://127.0.0.1:8550"
else
  "$ROOT/run-host.sh" >>"$ROOT/logs/host.out" 2>&1 &
  HOST_PID=$!
  echo "host gateway starting (pid $HOST_PID), log: $ROOT/logs/host.out"
  for _ in $(seq 1 40); do
    ss -ltn 2>/dev/null | grep -q '127.0.0.1:8550' && break
    sleep 0.25
  done
  if ! ss -ltn 2>/dev/null | grep -q '127.0.0.1:8550'; then
    echo "host gateway did not come up; tail $ROOT/logs/host.out" >&2
    exit 1
  fi
fi

"$ROOT/run-recon.sh" "$@"
