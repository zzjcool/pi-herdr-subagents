#!/usr/bin/env bash
# Copy host Pi config into a disposable docker home and point packages at /plugin.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAGING="${DOCKER_PI_HOME:-/tmp/pi-herdr-docker-home}"
SRC="${HOST_PI_AGENT:-/root/.pi/agent}"

rm -rf "$STAGING"
mkdir -p "$STAGING/.pi/agent/profiles" "$STAGING/work"

cp "$SRC/settings.json" "$STAGING/.pi/agent/settings.json"
cp "$SRC/models.json" "$STAGING/.pi/agent/models.json"
cp "$SRC/auth.json" "$STAGING/.pi/agent/auth.json" 2>/dev/null || true
cp "$SRC/AGENTS.md" "$STAGING/.pi/agent/AGENTS.md" 2>/dev/null || true
if [ -d "$SRC/profiles" ]; then
  cp -a "$SRC/profiles/." "$STAGING/.pi/agent/profiles/"
fi

python3 - <<PY
import json
from pathlib import Path
agent = Path("$STAGING/.pi/agent")
settings = json.loads((agent / "settings.json").read_text())
settings["packages"] = ["/plugin"]
settings["defaultProvider"] = "mock"
settings["defaultModel"] = "flash"
settings["defaultThinkingLevel"] = "off"
settings["defaultProjectTrust"] = "always"
(agent / "settings.json").write_text(json.dumps(settings, indent=2) + "\n")

models = json.loads((agent / "models.json").read_text())
models.setdefault("providers", {})
models["providers"]["mock"] = {
    "baseUrl": "http://127.0.0.1:8765/v1",
    "api": "openai-completions",
    "apiKey": "mock",
    "compat": {
        "supportsDeveloperRole": False,
        "supportsReasoningEffort": False,
        "supportsUsageInStreaming": True,
        "supportsFinishReason": True,
    },
    "models": [{
        "id": "flash",
        "name": "Mock Flash",
        "reasoning": False,
        "input": ["text"],
        "contextWindow": 32000,
        "maxTokens": 2048,
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
    }],
}
(agent / "models.json").write_text(json.dumps(models, indent=2) + "\n")
print("docker home ready", agent)
PY
