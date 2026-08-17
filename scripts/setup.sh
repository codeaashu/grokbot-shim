#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GROKBOT_RESOURCES="${GROKBOT_RESOURCES:-/opt/Grok Bot/resources}"
ASAR="$GROKBOT_RESOURCES/app.asar"
UNPACKED="$GROKBOT_RESOURCES/app.asar.unpacked"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing prerequisite: $1" >&2
    exit 1
  }
}

require node
require npm
require openssl
require cp

if [[ ! -f "$ASAR" || ! -d "$UNPACKED/dist/deps" ]]; then
  echo "Grok Bot resources were not found at: $GROKBOT_RESOURCES" >&2
  echo "Install Grok Bot or set GROKBOT_RESOURCES to its resources directory." >&2
  exit 1
fi

if [[ ! -x "$ROOT/node_modules/.bin/asar" ]]; then
  echo "installing Node.js dependencies..."
  npm --prefix "$ROOT" ci
fi

mkdir -p "$ROOT/certs" "$ROOT/host/dist/host" "$ROOT/host/dist/deps"
mkdir -p "$ROOT/appdata" "$ROOT/logs" "$ROOT/state/host-workdir"

if [[ ! -f "$ROOT/certs/rootCA.pem" || ! -f "$ROOT/certs/rootCA.key" ]]; then
  echo "generating local certificate authority..."
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
    -subj "/CN=grokbot-shim local CA" \
    -keyout "$ROOT/certs/rootCA.key" \
    -out "$ROOT/certs/rootCA.pem" >/dev/null 2>&1
fi

if [[ ! -f "$ROOT/certs/localhost.pem" || ! -f "$ROOT/certs/localhost.key" ]]; then
  echo "generating localhost certificate..."
  openssl req -newkey rsa:2048 -nodes -sha256 \
    -subj "/CN=localhost" \
    -keyout "$ROOT/certs/localhost.key" \
    -out "$ROOT/certs/localhost.csr" >/dev/null 2>&1
  openssl x509 -req -sha256 -days 825 \
    -in "$ROOT/certs/localhost.csr" \
    -CA "$ROOT/certs/rootCA.pem" \
    -CAkey "$ROOT/certs/rootCA.key" \
    -CAcreateserial \
    -extfile <(printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n') \
    -out "$ROOT/certs/localhost.pem" >/dev/null 2>&1
fi

echo "extracting the host runtime from the local Grok Bot installation..."
(
  cd "$ROOT/host/dist/host"
  "$ROOT/node_modules/.bin/asar" extract-file "$ASAR" dist/host/host-main.cjs
  "$ROOT/node_modules/.bin/asar" extract-file "$ASAR" dist/host/host-main.cjs.map
)
cp -a "$UNPACKED/dist/deps/." "$ROOT/host/dist/deps/"

if [[ ! -s "$ROOT/host/dist/host/host-main.cjs" ]]; then
  echo "host runtime extraction failed" >&2
  exit 1
fi

echo "setup complete"
echo "next: $ROOT/run-all.sh"
