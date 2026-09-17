#!/usr/bin/env bash
set -euo pipefail
node /opt/test/mock-llm.mjs >/tmp/mock-llm.stdout 2>/tmp/mock-llm.stderr &
for i in $(seq 1 25); do
  if node -e 'fetch("http://127.0.0.1:8765/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then
    break
  fi
  sleep 0.2
done

cd /plugin
node --experimental-strip-types --test test/unit/budget.test.ts test/unit/child-guard.test.ts
echo "===== UNIT IN CONTAINER PASS ====="

cd /root/work
set +e
PI_SUBAGENT_CHILD=1 HERDR_PANE_ID=w1:p1 PI_SUBAGENT_MAX_TOOL_CALLS=0 \
  pi --print --no-session --no-skills --no-prompt-templates --no-themes --no-extensions \
    -e /plugin/index.ts --tools bash --thinking off --provider mock --model flash --offline \
    "list the files" > /tmp/pi-out.txt 2>/tmp/pi-err.txt
set -e
echo "===== PI PRINT ====="
cat /tmp/pi-out.txt
echo "===== PI ERR (tail) ====="
tail -n 40 /tmp/pi-err.txt || true

if grep -Eqi 'tool budget exceeded' /tmp/pi-out.txt /tmp/pi-err.txt; then
  echo "===== RESULT: PASS tool budget blocked ====="
  exit 0
fi
echo "===== RESULT: FAIL tool budget did not fire ====="
exit 1
