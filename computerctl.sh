#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${GROKBOT_COMPUTER_CONTAINER:-grokbot-computer}"
IMAGE="${GROKBOT_COMPUTER_IMAGE:-public.ecr.aws/k0i0n2g5/cursorenvironments/universal@sha256:dcac90cba36653f261988b1c88d11b7655493d455c4af0a18c5991ddaa5da020}"

require_docker() {
  command -v docker >/dev/null 2>&1 || {
    echo "Docker is required for the packaged Grok Bot desktop runtime." >&2
    exit 1
  }
  docker info >/dev/null 2>&1 || {
    echo "Docker is installed but its daemon is not available." >&2
    exit 1
  }
}

exists() {
  docker container inspect "$CONTAINER" >/dev/null 2>&1
}

is_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" = "true" ]
}

is_ready() {
  curl -fsS --max-time 2 http://127.0.0.1:6080/vnc.html >/dev/null 2>&1 &&
    curl -sS --max-time 2 http://127.0.0.1:1337/health >/dev/null 2>&1
}

wait_ready() {
  for _ in $(seq 1 120); do
    if is_ready; then
      echo "computer ready: http://127.0.0.1:6080/vnc.html"
      return 0
    fi
    sleep 0.5
  done
  echo "computer did not become ready; inspect: $0 logs" >&2
  return 1
}

start() {
  require_docker
  if exists; then
    if is_running; then
      echo "computer container already running: $CONTAINER"
    else
      docker start "$CONTAINER" >/dev/null
      echo "computer container started: $CONTAINER"
    fi
  else
    if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
      echo "pulling Grok Bot computer image (first run is several GB)..."
      docker pull "$IMAGE"
    fi
    docker run -d \
      --name "$CONTAINER" \
      --restart unless-stopped \
      --shm-size=1g \
      -p 127.0.0.1:1337:1337 \
      -p 127.0.0.1:1338:1338 \
      -p 127.0.0.1:1339:1339 \
      -p 127.0.0.1:6080:6080 \
      -p 127.0.0.1:6081:6081 \
      -v grokbot-computer-workspace:/workspace \
      -v grokbot-computer-chrome:/home/box/chrome-profile \
      -v grokbot-computer-data:/home/box/sand-data \
      "$IMAGE" >/dev/null
    echo "computer container created: $CONTAINER"
  fi
  wait_ready
}

status() {
  require_docker
  if ! exists; then
    echo "computer absent: $CONTAINER"
    return 1
  fi
  if ! is_running; then
    echo "computer stopped: $CONTAINER"
    return 1
  fi
  if is_ready; then
    echo "computer ready: $CONTAINER (http://127.0.0.1:6080/vnc.html)"
    return 0
  fi
  echo "computer running but not ready: $CONTAINER"
  return 1
}

case "${1:-status}" in
  start) start ;;
  stop)
    require_docker
    if exists && is_running; then
      docker stop "$CONTAINER" >/dev/null
      echo "computer stopped: $CONTAINER"
    else
      echo "computer already stopped: $CONTAINER"
    fi
    ;;
  restart)
    require_docker
    if exists && is_running; then docker stop "$CONTAINER" >/dev/null; fi
    start
    ;;
  status) status ;;
  logs)
    require_docker
    docker logs --tail 200 "$CONTAINER"
    ;;
  open)
    status >/dev/null
    xdg-open http://127.0.0.1:6080/vnc.html
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs|open}" >&2
    exit 2
    ;;
esac
