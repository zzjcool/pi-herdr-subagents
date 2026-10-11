#!/usr/bin/env bash
set -euo pipefail
cd /plugin
node --experimental-strip-types --test \
  --test-name-pattern "RPC start fallback|modelCandidates" \
  test/unit/agents-model.test.ts test/integration/regressions.test.ts
echo "===== RESULT: PASS RPC start fallback + modelCandidates ====="
