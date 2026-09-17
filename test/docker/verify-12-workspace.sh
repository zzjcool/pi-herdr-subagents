#!/usr/bin/env bash
# Container: install Pi + this plugin, then prove a child lands in the parent
# herdr Space even when another Space is focused.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
chmod +x "$ROOT/test/docker/"*.sh "$ROOT/test/docker/"*.mjs
export DOCKER_PI_HOME="${DOCKER_PI_HOME:-/tmp/pi-herdr-workspace-docker-home}"
bash "$ROOT/test/docker/prepare-home.sh"

# Force a real `pi install` inside the container: do not pre-register /plugin.
python3 - <<PY
import json
from pathlib import Path
p = Path("$DOCKER_PI_HOME/.pi/agent/settings.json")
s = json.loads(p.read_text())
s["packages"] = []
# Host overrides pin scout to a live provider; this sandbox uses mock.
sub = s.setdefault("subagents", {})
sub.pop("agentOverrides", None)
p.write_text(json.dumps(s, indent=2) + "\n")
print("packages cleared for pi install; agentOverrides stripped")
PY

mkdir -p "$DOCKER_PI_HOME/.config/herdr" "$DOCKER_PI_HOME/work" "$DOCKER_PI_HOME/other"
cat > "$DOCKER_PI_HOME/.config/herdr/config.toml" <<'TOML'
onboarding = false
TOML

IMAGE="${PI_DOCKER_IMAGE:-pi-herdr-sandbox:latest}"
docker run --rm -u 0 \
  -e HOME=/root \
  -e TERM=xterm-256color \
  -e PI_OFFLINE=1 \
  -e MOCK_TOOL_NAME=subagent \
  -e MOCK_TOOL_ARGS='{"agent":"scout","task":"Reply with exactly SPACE_PIN_OK then a verdict JSON."}' \
  -e HERDR_SOCKET_PATH=/tmp/space-pin-herdr.sock \
  -v "$ROOT:/plugin:ro" \
  -v "$DOCKER_PI_HOME:/root" \
  -v "$ROOT/test/docker:/opt/test:ro" \
  -w /root/work \
  "$IMAGE" \
  bash /opt/test/inside-12-workspace.sh
