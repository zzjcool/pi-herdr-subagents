#!/usr/bin/env bash
# Run a command inside pi-herdr-sandbox with host Pi config + this plugin.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAGING="${DOCKER_PI_HOME:-/tmp/pi-herdr-docker-home}"
IMAGE="${PI_DOCKER_IMAGE:-pi-herdr-sandbox:latest}"

bash "$ROOT/test/docker/prepare-home.sh"

docker run --rm -u 0 \
  -e HOME=/root \
  -e TERM=xterm-256color \
  -e PI_OFFLINE=1 \
  -e MOCK_TOOL_NAME="${MOCK_TOOL_NAME:-}" \
  -e MOCK_TOOL_ARGS="${MOCK_TOOL_ARGS:-}" \
  -e PI_SUBAGENT_CHILD="${PI_SUBAGENT_CHILD:-}" \
  -e HERDR_PANE_ID="${HERDR_PANE_ID:-}" \
  -e PI_SUBAGENT_ACCEPTANCE_ROLE="${PI_SUBAGENT_ACCEPTANCE_ROLE:-}" \
  -e PI_SUBAGENT_MAX_TOOL_CALLS="${PI_SUBAGENT_MAX_TOOL_CALLS:-}" \
  -e PI_SUBAGENT_MAX_TURNS="${PI_SUBAGENT_MAX_TURNS:-}" \
  -e PI_SUBAGENT_TOOL_TIMEOUT_MS="${PI_SUBAGENT_TOOL_TIMEOUT_MS:-}" \
  -e PI_SUBAGENT_ALLOW_NESTED="${PI_SUBAGENT_ALLOW_NESTED:-}" \
  -v "$ROOT:/plugin:ro" \
  -v "$STAGING:/root" \
  -v "$ROOT/test/docker:/opt/test:ro" \
  -w /root/work \
  "$IMAGE" \
  bash -lc "$*"
