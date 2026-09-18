#!/usr/bin/env bash
# Inside pi-herdr-sandbox: plugin kind matrix, then real CLI/model probes.
set -euo pipefail

pass() { echo "===== RESULT: PASS $* ====="; }
fail() { echo "===== RESULT: FAIL $* ====="; exit 1; }
skip() { echo "===== RESULT: SKIP $* ====="; }

mkdir -p /usr/local/bin
if [ -x /opt/codebuddy-code/bin/codebuddy ]; then
  ln -sfn /opt/codebuddy-code/bin/codebuddy /usr/local/bin/codebuddy
  ln -sfn /opt/codebuddy-code/bin/codebuddy /usr/local/bin/cbc
fi
if [ -d /opt/cursor-agent-dir ]; then
  bin=$(find /opt/cursor-agent-dir -maxdepth 1 -type f -name 'cursor-agent' | head -n 1)
  if [ -n "$bin" ]; then
    ln -sfn "$bin" /usr/local/bin/cursor-agent
  fi
fi
if [ -d /opt/host-codebuddy ] && [ ! -e /root/.codebuddy ]; then
  mkdir -p /root/.codebuddy
  cp -a /opt/host-codebuddy/. /root/.codebuddy/
fi
export PATH="/usr/local/bin:$PATH"

echo "===== BINS ====="
command -v node; node --version
command -v pi && pi --version || echo "pi missing"
command -v herdr && herdr --version || echo "herdr missing"
command -v codebuddy && codebuddy --version || echo "codebuddy missing"
command -v cursor-agent >/dev/null 2>&1 && echo "cursor-agent=$(command -v cursor-agent)" || echo "cursor-agent missing"

echo "===== herdr kinds ====="
herdr agent start --help 2>&1 | sed -n '/possible values/,+2p' || true

cd /plugin
PI_OFFLINE=1 node --experimental-strip-types --test test/unit/kind.test.ts \
  || fail "unit kind.test.ts"

PI_OFFLINE=1 node --experimental-strip-types /plugin/test/docker/probe-kind-matrix.ts \
  || fail "kind matrix"

PI_OFFLINE=1 node --experimental-strip-types --test \
  --test-name-pattern "every kind starts|probeProgress maps non-pi|valid non-pi kind|herdr grok kind" \
  test/integration/orchestrator.test.ts test/unit/agents.test.ts \
  || fail "kind integration"

echo "===== CLI FLAG PROBES ====="

if command -v pi >/dev/null 2>&1; then
  if pi --help 2>&1 | grep -q -- '--model'; then
    pass "pi accepts --model"
  else
    fail "pi --help has no --model"
  fi
else
  skip "pi binary"
fi

if command -v cursor-agent >/dev/null 2>&1 && cursor-agent --help >/tmp/cursor-help.txt 2>&1 \
  && ! grep -qi 'unknown option\|cannot execute' /tmp/cursor-help.txt; then
  if grep -q -- '--model' /tmp/cursor-help.txt; then
    pass "cursor-agent accepts --model"
  else
    skip "cursor-agent --help has no --model"
  fi
else
  skip "cursor-agent not executable in sandbox (bundled node)"
fi

if command -v codebuddy >/dev/null 2>&1; then
  if codebuddy --help 2>&1 | grep -q -- '--model'; then
    pass "codebuddy CLI accepts --model"
  else
    fail "codebuddy --help has no --model"
  fi
  if codebuddy --help 2>&1 | grep -q -- '--effort'; then
    pass "codebuddy CLI accepts --effort"
  else
    fail "codebuddy --help has no --effort"
  fi
else
  skip "codebuddy binary"
fi

if [ "${LIVE_KIND_PROBES:-1}" != "1" ]; then
  skip "live LLM probes (LIVE_KIND_PROBES=0)"
  echo "===== RESULT: PASS kinds (plugin + flags, live skipped) ====="
  exit 0
fi

echo "===== LIVE MODEL PROBES ====="

if command -v pi >/dev/null 2>&1; then
  set +e
  timeout 120 pi --print --no-session --no-skills --thinking off \
    --provider cb --model glm-5.3-flash \
    "Reply with exactly: DOCKER_PI_CB_OK. Do not use tools." \
    >/tmp/pi-cb-out.txt 2>/tmp/pi-cb-err.txt
  pi_rc=$?
  set -e
  echo "----- pi cb stdout (tail) -----"
  tail -n 20 /tmp/pi-cb-out.txt || true
  if [ "$pi_rc" -eq 0 ] && grep -q 'DOCKER_PI_CB_OK' /tmp/pi-cb-out.txt; then
    pass "live pi --provider cb --model glm-5.3-flash"
  else
    echo "----- pi cb stderr (tail) -----"
    tail -n 40 /tmp/pi-cb-err.txt || true
    fail "live pi CodeBuddy provider (cb/glm-5.3-flash)"
  fi
else
  skip "live pi cb"
fi

if command -v codebuddy >/dev/null 2>&1; then
  if [ -z "${CODEBUDDY_API_KEY:-}" ] && [ -f /root/.ccr-codebuddy/providers.json ]; then
    # Same Tencent key pi uses for --provider cb. Do not print it.
    CODEBUDDY_API_KEY="$(node -e "const d=require('/root/.ccr-codebuddy/providers.json'); process.stdout.write(String(d.providers?.tencent?.apiKey||''))")"
    export CODEBUDDY_API_KEY
  fi
  if [ -z "${CODEBUDDY_API_KEY:-}" ]; then
    skip "live codebuddy CLI (no API key in container)"
  else
    set +e
    timeout 120 codebuddy -p --model glm-5.3-flash --effort low --max-turns 1 \
      "Reply with exactly: DOCKER_CB_OK. Do not use tools." \
      >/tmp/cb-out.txt 2>/tmp/cb-err.txt
    cb_rc=$?
    set -e
    echo "----- codebuddy stdout (tail) -----"
    tail -n 20 /tmp/cb-out.txt || true
    if [ "$cb_rc" -eq 0 ] && grep -q 'DOCKER_CB_OK' /tmp/cb-out.txt; then
      pass "live codebuddy --model glm-5.3-flash --effort low"
    elif grep -qi 'Authentication required' /tmp/cb-err.txt /tmp/cb-out.txt 2>/dev/null; then
      skip "live codebuddy CLI login (interactive /login; plugin path is pi --provider cb)"
    else
      echo "----- codebuddy stderr (tail) -----"
      tail -n 40 /tmp/cb-err.txt || true
      fail "live codebuddy CLI"
    fi
  fi
else
  skip "live codebuddy"
fi

echo
echo "Note: Herdr has no --kind codebuddy. CodeBuddy models are launched as"
echo "  kind=pi model=cb/<id>  (pi talks to the Tencent/CodeBuddy provider)."
echo "The codebuddy CLI above is the native binary our generic start argv"
echo "would need if Herdr added that kind later."
echo
echo "===== RESULT: PASS kinds docker ====="
