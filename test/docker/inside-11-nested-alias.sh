#!/usr/bin/env bash
set -euo pipefail
cd /plugin
node --experimental-strip-types --test test/unit/child-mode.test.ts test/unit/args.test.ts
echo "===== UNIT IN CONTAINER PASS ====="
node --experimental-strip-types --test \
  --test-name-pattern "findAgent|completionGuard|allowNested|nested-allowed" \
  test/unit/agents.test.ts test/unit/args.test.ts test/integration/orchestrator.test.ts
echo "===== RESULT: PASS nested / alias / completionGuard ====="
