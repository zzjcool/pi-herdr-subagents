#!/usr/bin/env bash
# Isolated docker check: kind/model argv matrix + host CLIs (pi/cb, codebuddy, cursor).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
chmod +x "$ROOT/test/docker/"*.sh "$ROOT/test/docker/"*.mjs 2>/dev/null || true
export DOCKER_PI_HOME="${DOCKER_PI_HOME:-/tmp/pi-herdr-kinds-docker-home}"
bash "$ROOT/test/docker/prepare-home.sh"

IMAGE="${PI_DOCKER_IMAGE:-pi-herdr-sandbox:latest}"
CODEBUDDY_PKG="${CODEBUDDY_PKG:-$(npm root -g)/@tencent-ai/codebuddy-code}"
HOST_CURSOR_AGENT="${HOST_CURSOR_AGENT:-}"
if [ -z "$HOST_CURSOR_AGENT" ] && [ -x /root/.local/bin/agent ]; then
  HOST_CURSOR_AGENT="$(readlink -f /root/.local/bin/agent || true)"
fi
CCR_DIR="${CCR_DIR:-/root/.ccr-codebuddy}"
CODEBUDDY_HOME="${CODEBUDDY_HOME:-/root/.codebuddy}"

MOUNTS=(
  -v "$ROOT:/plugin:ro"
  -v "$DOCKER_PI_HOME:/root"
  -v "$ROOT/test/docker:/opt/test:ro"
)
if [ -d "$CODEBUDDY_PKG" ]; then
  MOUNTS+=(-v "$CODEBUDDY_PKG:/opt/codebuddy-code:ro")
fi
if [ -d "$CODEBUDDY_HOME" ]; then
  MOUNTS+=(-v "$CODEBUDDY_HOME:/opt/host-codebuddy:ro")
fi
if [ -d "$CCR_DIR" ]; then
  MOUNTS+=(-v "$CCR_DIR:/root/.ccr-codebuddy:ro")
fi
if [ -n "$HOST_CURSOR_AGENT" ] && [ -e "$HOST_CURSOR_AGENT" ]; then
  MOUNTS+=(-v "$(dirname "$HOST_CURSOR_AGENT"):/opt/cursor-agent-dir:ro")
fi

docker run --rm -u 0 \
  -e HOME=/root \
  -e TERM=xterm-256color \
  -e LIVE_KIND_PROBES="${LIVE_KIND_PROBES:-1}" \
  "${MOUNTS[@]}" \
  -w /plugin \
  "$IMAGE" \
  bash /opt/test/inside-13-kinds.sh
