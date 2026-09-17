#!/usr/bin/env bash
set -euo pipefail
cd /plugin
node --experimental-strip-types --test test/unit/acceptance.test.ts
echo "===== UNIT IN CONTAINER PASS ====="
node --experimental-strip-types --test \
  --test-name-pattern "verification-output" \
  test/integration/orchestrator.test.ts
echo "===== RESULT: PASS collect verification ====="
