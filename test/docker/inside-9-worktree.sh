#!/usr/bin/env bash
set -euo pipefail
cd /plugin
node --experimental-strip-types --test test/unit/worktree.test.ts
echo "===== UNIT IN CONTAINER PASS ====="
node --experimental-strip-types --test \
  --test-name-pattern "worktree" \
  test/integration/orchestrator.test.ts
echo "===== RESULT: PASS git worktree isolation ====="
