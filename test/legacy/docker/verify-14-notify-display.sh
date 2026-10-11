#!/usr/bin/env bash
# Legacy interactive notification scenario retained separately from the RPC mainline Docker gate.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STAGING="${DOCKER_PI_HOME:-/tmp/pi-herdr-docker-home}"
IMAGE="${PI_DOCKER_IMAGE:-pi-herdr-sandbox:latest}"
bash "$ROOT/test/docker/prepare-home.sh"
python3 - <<'PY'
# Force every subagent model to the mock provider (no live credentials).
import json
from pathlib import Path
p = Path("${STAGING:-/tmp/pi-herdr-docker-home}") / ".pi/agent/settings.json"
s = json.loads(p.read_text())
sa = s.setdefault("subagents", {})
for v in sa.get("agentOverrides", {}).values():
    if "model" in v:
        v["model"] = "mock/flash"
for v in sa.get("presets", {}).values():
    if "model" in v and "kind" not in v:
        v["model"] = "mock/flash"
p.write_text(json.dumps(s, indent=2) + "\n")
PY
docker run --rm -u 0 \
  -e HOME=/root -e TERM=xterm-256color \
  -v "$ROOT:/plugin:ro" \
  -v "$STAGING:/root" \
  -v "$ROOT/test/legacy/docker:/opt/notify:ro" \
  -w /root/work \
  "$IMAGE" \
  bash /opt/notify/inside-notify-tui.sh
