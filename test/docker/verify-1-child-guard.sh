#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
chmod +x "$ROOT/test/docker/"*.sh "$ROOT/test/docker/"*.mjs
bash "$ROOT/test/docker/prepare-home.sh"
STAGING="${DOCKER_PI_HOME:-/tmp/pi-herdr-docker-home}"
IMAGE="${PI_DOCKER_IMAGE:-pi-herdr-sandbox:latest}"

docker run --rm -u 0 \
  -e HOME=/root \
  -e TERM=xterm-256color \
  -e PI_OFFLINE=1 \
  -e MOCK_TOOL_NAME=bash \
  -e MOCK_TOOL_ARGS='{"command":"herdr agent prompt orchestrator please take this result"}' \
  -v "$ROOT:/plugin:ro" \
  -v "$STAGING:/root" \
  -v "$ROOT/test/docker:/opt/test:ro" \
  -w /root/work \
  "$IMAGE" \
  bash /opt/test/inside-1-child-guard.sh
