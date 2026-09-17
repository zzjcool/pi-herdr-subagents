#!/usr/bin/env bash
# Install Pi (already in image; re-check) + plugin, then launch a child while
# another herdr Space is focused. The child must land in the parent Space.
set -euo pipefail

export HERDR_SOCKET_PATH="${HERDR_SOCKET_PATH:-/tmp/space-pin-herdr.sock}"
export HERDR_CONFIG_PATH=/root/.config/herdr/config.toml
export HERDR_ENV=1

mkdir -p /root/work /root/other /tmp
if [ ! -d /root/work/.git ]; then
  cd /root/work
  git init -q
  git config user.email t@t
  git config user.name t
  echo pin > README
  git add README
  git commit -qm init
fi
cd /root/work

echo "### 0. Pi in image"
command -v pi
pi --version

echo "### 1. install plugin from /plugin (not pre-registered)"
node --input-type=module - <<'JS'
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync("/root/.pi/agent/settings.json", "utf8"));
if (Array.isArray(s.packages) && s.packages.length) {
  console.error("FAIL: packages already set, pi install would be a no-op", s.packages);
  process.exit(1);
}
console.log("packages before install: []");
console.log("defaultProvider", s.defaultProvider, "defaultModel", s.defaultModel);
JS

set +e
pi install /plugin --no-approve > /tmp/pi-install.out 2>/tmp/pi-install.err
INSTALL_CODE=$?
set -e
echo "pi_install_exit=$INSTALL_CODE"
cat /tmp/pi-install.out || true
if [ "$INSTALL_CODE" != 0 ]; then
  echo "----- pi install stderr -----"
  cat /tmp/pi-install.err || true
  exit 1
fi
echo "----- pi list -----"
pi list || true
node --input-type=module - <<'JS'
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync("/root/.pi/agent/settings.json", "utf8"));
const pkgs = s.packages ?? [];
console.log("packages after install", pkgs);
if (!pkgs.some((p) => String(p).includes("plugin") || String(p).includes("herdr-subagents"))) {
  console.error("FAIL: pi install did not register /plugin");
  process.exit(1);
}
JS

echo "### 2. mock LLM + isolated herdr server"
node /opt/test/mock-llm.mjs >/tmp/mock-llm.stdout 2>/tmp/mock-llm.stderr &
for i in $(seq 1 25); do
  if node -e 'fetch("http://127.0.0.1:8765/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then
    break
  fi
  sleep 0.2
done

(herdr server >/tmp/herdr-server.log 2>&1 &)
up=0
for i in $(seq 1 20); do
  if herdr status server 2>/dev/null | grep -q "status: running"; then
    up=1
    echo "  herdr server up (${i}s)"
    break
  fi
  sleep 0.5
done
if [ "$up" != 1 ]; then
  echo "FAIL: herdr server did not start"
  tail -40 /tmp/herdr-server.log || true
  exit 1
fi

echo "### 3. group Space vs focused distractor"
node /opt/test/setup-spaces.mjs

# shellcheck disable=SC1091
source /tmp/space-pin-env.sh
echo "GROUP_WS=$GROUP_WS OTHER_WS=$OTHER_WS GROUP_PANE=$GROUP_PANE"
export HERDR_WORKSPACE_ID="$GROUP_WS"
export HERDR_TAB_ID="$GROUP_TAB"
export HERDR_PANE_ID="$GROUP_PANE"

echo "### 4. parent Pi (installed plugin, no -e) launches scout via subagent tool"
set +e
timeout 120 pi --print --no-session --thinking off --offline \
  --provider mock --model flash \
  --no-builtin-tools --tools subagent \
  -p "Launch a scout subagent for the task. Do not run herdr yourself." \
  > /tmp/pi-parent.out 2>/tmp/pi-parent.err
PARENT_CODE=$?
set -e
echo "parent_exit=$PARENT_CODE"
echo "----- parent stdout -----"
cat /tmp/pi-parent.out || true
if [ "$PARENT_CODE" != 0 ]; then
  echo "----- parent stderr (tail) -----"
  tail -n 80 /tmp/pi-parent.err || true
fi

echo "### 5. where did the child land?"
node /opt/test/assert-child-space.mjs
echo "===== RESULT: PASS child pinned to parent herdr Space ====="
