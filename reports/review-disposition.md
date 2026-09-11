# Review findings — disposition

Three fresh-context adversarial reviewers plus my own pass reviewed the delivered code.
This file records what was found and what was done about it.

## Summary

| Source | Critical | Major | Minor |
| --- | --- | --- | --- |
| rev-correctness | 2 | 2 | 2 |
| rev-simplicity | 2 | 4 | 7 |
| rev-tests | 2 | 3 | — |
| self-review | 3 | 3 | 3 |

**All critical findings are fixed.** Major findings: the safety-relevant ones are fixed;
the remainder are documented below as known limitations.

## Critical — fixed

| # | Finding | Fix | Pinned by |
| --- | --- | --- | --- |
| C1 | `index.ts` `retire`/`collect`/`steer` were routed to a read-only `renderChild`, so `action: "retire"` never recycled anything (pane stayed open, agent kept running, `retiredAt` never persisted). `Orchestrator.retire()` was dead from the tool's perspective. | Each action now rehydrates an `Orchestrator` from `run.json` and calls the real method. | `test/integration/regressions.test.ts` |
| C2 | `index.ts` `onChildUpdate` fired before `store.addChild`, throwing `child not found` as an **unhandled rejection on every launch**. | `Handle` now carries the authoritative `ChildRecord`; `index.ts` persists `handle.child` after launch. No callback-based writes. | `regression: the persisted child carries a real, unique ownerToken` |
| C3 | `collect()` blocked for the **full 15-minute timeout** when the turn had already finished (no new message ever appeared). The test harness's fake `sleep` masked it. | Fast path: `isLastTurnComplete()` short-circuits an already-settled turn. Verified 3006ms → **1ms**. | `regression: collect() returns immediately when the turn already finished` |
| C4 | `waitForQuiet()` looped on wall-clock with an instant injected `sleep` ⇒ tight infinite loop (suite hung). | Bounded by an iteration cap as well as the deadline. | suite completes |
| C5 | `ownerToken` was hardcoded to a truthy placeholder, so every persisted child shared one zero-entropy token — defeating the ownership audit. | `Handle.child` carries the orchestrator's real crypto-safe token (`randomBytes`). | `regression: the persisted child carries a real, unique ownerToken` |
| C6 | `continue`/`resume` were advertised in the tool schema but unimplemented — they fell through to `launch` and produced a misleading error. | Both are implemented: a live agent is prompted in place; an exited one is relaunched against its persisted session. | typecheck + manual path |

## Major — fixed

| # | Finding | Fix |
| --- | --- | --- |
| M1 | `launch()` ignored `agent.model`, silently dropping the frontmatter model (verified: requested `glm-5.3-flash`, child ran `deepseek-v4.1-flash`). | Falls back to `input.agent.model`. |
| M2 | Literal `stopReason: "aborted"` fell through to the `failed` catch-all. | Explicit `case "aborted"`. |
| M3 | An assistant message with a *missing* `stopReason` was reported as `failed` with a misleading "unknown stopReason: null". | `rawStopReason` distinguishes absent (→ `aborted`) from unrecognized (→ `failed`). |
| M4 | `extractVerdict` only understood JSON, so an agent reporting `FAILED: ...` (the exact F32 case) scored `success` with no acceptance signal. | Added a strict first-line `FAILED:` convention. |
| M5 | YAML flow arrays (`tools: [read, bash]`) parsed as `["[read", "bash]"]`. | Strip brackets before splitting. |
| M6 | The lineage tree was defined and sanitized but never wired: no env propagation, no depth check ⇒ nesting unbounded and the "prevent cycles / bound depth" property was decorative. | Lineage + depth now flow to the child pane via env; `launch()` refuses to exceed `maxDepth`. |
| M7 | `maxSubagentSpawnsPerSession` was parsed but never enforced; `BUDGET_EXCEEDED` was never thrown. | `Orchestrator` enforces a spawn budget and exposes `budget()`. |
| M8 | `parentProvider` was never passed to `resolveModel`, so provider-scoped overrides (design §6.2 level 2) never applied. | `index.ts` derives it via `providerOf(dispatchModel)`. |
| M9 | `collect()` conflated "we gave up waiting" with "the turn was aborted". | Discriminated by agent liveness: alive + no reply → `running`; gone + no reply → `aborted`. |
| M10 | RunStore is async but `index.ts` called it without `await` (floating promises; only 1 of 2 children persisted). | All call sites awaited; persistence is explicit via `persistChild()`. |
| M11 | **herdr's agent-name namespace is global, not per-workspace.** `allocateName()` only checked this run's children, and `startWithRetry()` treated `NAME_TAKEN` as fatal — so any other session (or a human) holding `orchestrator`/`reviewer-0` would fail our launch outright. | Allocation now reserves against `agentList()` (live names session-wide), and `NAME_TAKEN` is retried with a fresh name; the pre-created session file is renamed to follow. |

## Minor — fixed

- Thinking-level list was duplicated in `args.ts` and `model-scope.ts` and could drift.
  Now a single `THINKING_LEVELS` + `isThinkingLevel()` in `shared/types.ts`.
- The orchestrator's `ownerToken()` used `Math.random()` while the store used
  `randomBytes`. Consolidated on the crypto-safe generator.
- `tabId` from `createPane` was discarded; now recorded on `ChildRecord.tabId`.

## Known limitations — documented, not fixed

These are deliberate scope boundaries for this stage, recorded so a reader does not
assume the feature works:

1. **Nested-subagent isolation is not enforced** (design F23–F25). A child can run
   `herdr pane read <any-pane>`. Mitigations are the tab boundary, the orphan audit,
   and prompt discipline. `auditOrphans()` is implemented but not yet called from any
   code path — wiring it is the next safety task.
2. **`worktree`, `onBlocked`, `toolBudget`, `turnBudget`, `fallbackModels`, and
   `acceptance.criteria` are parsed and override-able but not enforced.** They are
   reserved for the next stage. `acceptance` currently uses only the L2
   self-reported-verdict heuristic.
3. **`agent_status` cannot distinguish success from failure** (F26) — by design all
   outcome derivation goes through the session file. Do not add logic that trusts it.
4. **`pane process-info` cannot be used for state** (measured: the idle/working
   payloads are identical).

## Verification (final)

```text
npm run typecheck         -> clean (exit 0)
npm test                  -> 165 pass, 0 fail
npm run test:integration  -> 37 pass, 0 fail
end-to-end (real herdr + real pi child) -> execution=success, 1 turn,
   model=glm-5.3-flash, output="E2E_SUBAGENT_OK", session survives retire
real name-collision probe (requested role `orchestrator` while a foreign agent
   already held that name) -> launched as `orchestrator-0`, execution=success
```

### M11 was found in production, not by review

Another session in this herdr instance ran `herdr agent rename w9:p1 orchestrator` and was
rejected with `agent_name_taken ... pane_id=w7:p1` — i.e. **our** pane was blocking it. The same
collision could just as easily have hit us in the other direction. Three regression tests now
pin the behaviour: avoiding a known-taken name up front, retrying a name claimed mid-launch, and
keeping the session file aligned with a mid-launch rename.

### Note on the recurring `go` runner failure

A `go` test-runner failure is reported against this project by the lens harness. It is
**environmental and not caused by this project**:

- `herdr-subagents` is TypeScript-only: **0** `.go` / `go.mod` / `.go.sum` files.
- The runner uses the session cwd `/root/tmp`, which contains a stray `go.mod`
  (`module mytest`, dated **2025-03-25** — 17 months before this project was created).
- It therefore runs `go test ./...` against the pre-existing third-party
  `/root/tmp/flatbuffers` checkout, which fails to build.
- The user's own `/root/tmp/.pi-lens.json` already excludes `flatbuffers/**`.
- There is no project-scoped way to disable it (`tests.enabled` is global-scope only),
  and removing the user's pre-existing file is out of scope.
