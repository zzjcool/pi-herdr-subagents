#!/usr/bin/env bash
set -euo pipefail
cd /plugin
node --experimental-strip-types --test test/unit/recycle.test.ts
echo "===== UNIT IN CONTAINER PASS ====="
node --experimental-strip-types --test \
  --test-name-pattern "M1 lifecycle|canUseCachedCollect|cached snapshot|formatAlreadyRecycled" \
  test/unit/runtime.test.ts test/unit/recycle.test.ts \
  test/integration/orchestrator.test.ts
echo "===== RESULT: PASS collect cache and retire no-op ====="
