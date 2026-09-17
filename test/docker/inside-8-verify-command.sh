#!/usr/bin/env bash
set -euo pipefail
cd /plugin
node --experimental-strip-types --test test/unit/acceptance.test.ts
echo "===== UNIT IN CONTAINER PASS ====="
node --experimental-strip-types --test \
  --test-name-pattern "verification-output|criterion command|times out" \
  test/integration/orchestrator.test.ts test/unit/acceptance.test.ts
echo "===== RESULT: PASS verify command + timeout ====="
