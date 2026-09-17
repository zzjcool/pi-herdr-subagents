#!/usr/bin/env bash
set -euo pipefail
cd /plugin
node --experimental-strip-types --test test/unit/blocked.test.ts
echo "===== UNIT IN CONTAINER PASS ====="
node --experimental-strip-types --test \
  --test-name-pattern "blocked" \
  test/unit/runtime.test.ts test/integration/orchestrator.test.ts
echo "===== RESULT: PASS onBlocked forward ====="
