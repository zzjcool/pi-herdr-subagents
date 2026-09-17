#!/usr/bin/env bash
set -euo pipefail
cd /plugin
node --experimental-strip-types --test \
  --test-name-pattern "fallbackModels|modelCandidates" \
  test/unit/agents-model.test.ts test/integration/orchestrator.test.ts
echo "===== RESULT: PASS fallbackModels ====="
