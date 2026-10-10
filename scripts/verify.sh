#!/usr/bin/env bash
# Project-aware verification used by subagent acceptance (worker).
# Ships inside @zzjcool/pi-herdr-subagents; the orchestrator exports its
# directory as PI_SUBAGENTS_VERIFY_SH so agent prompts can stay portable.
#
# Modes:
#   verify.sh        or verify.sh full   — every detected verifier (default)
#   verify.sh fast                      — static checks only (typecheck/lint/vet)
#                                         plus .pi/verify-fast.sh when present
# Override: an executable .pi/verify.sh in the project root replaces full mode;
# an executable .pi/verify-fast.sh replaces fast mode.
# Exit 3 = nothing to verify with (fail loud rather than report a fake pass).
set -uo pipefail

mode="${1:-full}"

case "$mode" in
  full|fast) ;;
  *) echo "verify: unknown mode '$mode' (use: full|fast)" >&2; exit 2 ;;
esac

root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$root" || exit 2

if [ "$mode" = full ] && [ -x .pi/verify.sh ]; then
  echo "verify: project override .pi/verify.sh"
  exec ./.pi/verify.sh
fi
if [ "$mode" = fast ] && [ -x .pi/verify-fast.sh ]; then
  echo "verify: project override .pi/verify-fast.sh"
  exec ./.pi/verify-fast.sh
fi

ran=0
step() {
  echo "verify: $*"
  "$@" || exit $?
  ran=1
}

# --- Node -------------------------------------------------------------------
if [ -f package.json ]; then
  pm=npm
  [ -f pnpm-lock.yaml ] && pm=pnpm
  [ -f yarn.lock ] && pm=yarn
  { [ -f bun.lockb ] || [ -f bun.lock ]; } && pm=bun
  # A fresh git worktree has no node_modules. Install a real directory (not a
  # symlink: `node_modules/` in .gitignore does not match a symlink, so it
  # could get committed).
  deps=$(node -e "const p=require('./package.json');process.stdout.write(String(Object.keys({...p.dependencies,...p.devDependencies}).length))" 2>/dev/null || echo 0)
  if [ ! -d node_modules ] && [ "$deps" != "0" ]; then
    if [ "$pm" = npm ] && [ -f package-lock.json ]; then step npm ci; else step "$pm" install; fi
  fi
  has() { node -e "process.exit(require('./package.json').scripts?.['$1'] ? 0 : 1)" 2>/dev/null; }
  if has typecheck; then step "$pm" run typecheck
  elif has check; then step "$pm" run check
  fi
  has test && [ "$mode" = full ] && step "$pm" run test
fi

# --- JVM --------------------------------------------------------------------
if [ -f pom.xml ]; then
  if [ -x ./mvnw ]; then step ./mvnw -q -B test; else step mvn -q -B test; fi
elif [ -f build.gradle ] || [ -f build.gradle.kts ]; then
  if [ -x ./gradlew ]; then step ./gradlew test; else step gradle test; fi
fi

# --- Go / Rust / Python -----------------------------------------------------
if [ -f go.mod ]; then
  step go vet ./... 2>/dev/null || step go build ./...
  [ "$mode" = full ] && step go test ./...
fi
[ -f Cargo.toml ] && step cargo test
if [ -f pyproject.toml ] || [ -f setup.py ]; then
  if [ "$mode" = full ]; then
    if python3 -c 'import pytest' 2>/dev/null; then step python3 -m pytest -q
    else step python3 -m compileall -q .
    fi
  fi
fi

if [ "$ran" -eq 0 ]; then
  echo "verify: no verifier detected in $root." >&2
  echo "verify: add an executable .pi/verify.sh, or have the parent verify manually." >&2
  exit 3
fi
echo "verify: all checks passed ($mode)"
