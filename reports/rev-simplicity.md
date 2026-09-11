# Adversarial review — SIMPLICITY, DEAD CODE & API DESIGN

Scope: src/**, index.ts. All claims verified by grep across src/, test/, index.ts before being listed.

## CRITICAL

### C1. `ownerToken` is never actually persisted — hardcoded `"pending"` string ships to disk
- `index.ts:194` builds the `ChildRecord` passed to `store.addChild()` with a **literal string** `ownerToken: "pending"`.
- `Orchestrator.launch()` (`src/runs/orchestrator.ts:236`) *does* generate a real token via its own `ownerToken()` helper (`src/runs/orchestrator.ts:58`, `Math.random()`-based) and stores it in its **in-memory** `this.children` map — but `Handle` (the object `launch()` returns to `index.ts`) does not carry `ownerToken` at all (see `Handle` in `src/shared/types.ts`). So the caller in `index.ts` has no way to get the real token and fabricates the placeholder.
- `RunStore.addChild` (`src/runs/store.ts:280-284`) only replaces a **falsy** token with a freshly generated crypto-safe one (`newOwnerToken()`, `randomBytes`-based). `"pending"` is truthy, so it is kept verbatim, forever.
- Net effect: every `run.json` on disk records `ownerToken: "pending"` for every child. The design (`docs/design.md` §4.1, "ownerToken … proves ownership, guards against killing others' panes") depends on this field being unique per child; it is currently a constant string with zero entropy. Any orphan-audit / ownership-proof logic built on top of `ChildRecord.ownerToken` from the persisted store is defeated.
- Fix direction: `launch()` should return (or `Orchestrator` should expose) the real `ownerToken` it generated, or `index.ts` should read the freshly-created `ChildRecord` back from `orchestrator.childrenSnapshot()` instead of reconstructing one by hand.

### C2. Two of eight advertised tool actions (`continue`, `resume`) are unimplemented and silently misrouted
- `SubagentParams.action` in `index.ts:47-59` advertises `launch | continue | steer | resume | retire | status | collect | list` and the tool description repeats this list.
- In `execute()` (`index.ts:95-180`) there are explicit branches only for `list`, `status|collect|retire`, and `steer`. There is **no** `if (action === "continue")` or `if (action === "resume")` branch.
- Consequence: calling the tool with `action: "continue"` or `action: "resume"` falls straight through to the "launch-family actions" block (`index.ts:140` onward), which calls `buildPlan(params)`. Since a continue/resume call typically supplies only `name` + `message` (per the documented action semantics in `docs/design.md` §11) and no `agent`/`task`/`tasks`/`chain`, `buildPlan` returns `{ ok: false, message: "Provide one of: (agent+task), tasks[], or chain[]." }` — a confusing, unrelated error instead of "action not implemented" or actually performing a continue/resume.
- This is a real correctness gap between the documented/schema'd API and the implementation, not a stylistic nit — a caller following the tool's own description will get a misleading failure.

## MAJOR

### M1. Orchestrator/Store split is not clean — `ChildRecord` is constructed twice and can drift
- `Orchestrator.launch()` builds a full, correct `ChildRecord` internally (`src/runs/orchestrator.ts:230-243`: real `ownerToken`, `state: "working"`, `spawnedAt`, `kind`, `agent`, `tabId`) and keeps it in `this.children`.
- `index.ts:190-198` independently constructs a **second**, parallel `ChildRecord` to hand to `store.addChild()`, recomputing `spawnedAt` with a fresh `new Date().toISOString()` call (a few ms later than the orchestrator's own timestamp) and hardcoding `ownerToken: "pending"` (see C1).
- Because `Handle` (what `launch()` returns) is a narrow projection (`name`, `paneId`, `sessionFile`, `runId`, `agent`, `kind` — see `src/shared/types.ts` `Handle`), `index.ts` cannot recover the orchestrator's authoritative record and is forced to re-derive fields it already computed. This is the direct root cause of C1. The fix for C1 is really a fix for this structural issue: either `Handle` should carry the full `ChildRecord`, or `index.ts` should call `orchestrator.childrenSnapshot()` to source the just-created record instead of reconstructing one.
- Symmetrically, `Orchestrator` also doesn't own persistence itself — `onChildUpdate` (`OrchestratorDeps.onChildUpdate`) is a callback into the store for *subsequent* updates (`collect`, `retire`), but the *initial* `addChild` bypasses this callback entirely and is done directly by `index.ts`. So the store is written to from two different call sites with two different construction paths for what should be one record. This is a real "who owns what" boundary problem, not just style.

### M2. Large tree of parsed-but-never-enforced config — speculative weight in `types.ts` and `agents.ts`
Grepped every consumer; the following fields are parsed from frontmatter/settings, plumbed into types, and even support user-facing overrides, but have **zero** enforcement/consumption logic anywhere in `src/runs/orchestrator.ts` or `index.ts`:
- `AgentConfig.worktree` — parsed (`src/agents/agents.ts:232-233`), override-able (`src/agents/overrides.ts:33`) — but there is no `herdr worktree create` call anywhere in `src/herdr/client.ts` or the orchestrator. The design (§6.1) describes `worktree: true` as triggering write isolation; nothing implements it.
- `AgentConfig.onBlocked` — parsed, override-able, but the orchestrator has no `"blocked"` lifecycle handling at all (no code ever sets `state: "blocked"`, no forwarding/auto-approve/notify logic per design §5.3).
- `AgentConfig.toolBudget` / `TurnBudgetConfig` — parsed (`src/agents/agents.ts:119-131,239-242`) and override-able, never read by anything that would cap tool calls or turns.
- `AgentConfig.fallbackModels` — parsed and override-able, never consulted by `resolveModel` (`src/agents/model-resolution.ts`) or the orchestrator on failure.
- `AcceptanceConfig.criteria` / `.level` / `.role` — parsed (`src/agents/agents.ts:100-101`), but `Orchestrator.collect()` only ever does a crude self-reported-verdict heuristic (`extractVerdict`); it never looks at `agent.acceptance` at all, so `criteria`, `level: "verified"`, and the "read-only role degrades to attested" rule from design §3.5 are entirely unimplemented.
- `RunRecord.budget.limit` is hardcoded to `null` at creation (`src/runs/store.ts:193`) and `spawned` is incremented but never compared against `settings.maxSubagentSpawnsPerSession` anywhere — `ErrorCodes.BUDGET_EXCEEDED` is defined and never thrown.
- `NestedPathEntry` / `MAX_NESTED_PATH_ENTRIES` / `RunRecord.path` / `.depth` / `.maxDepth`, plus `AgentConfig.maxSubagentDepth` / `.allowNestedSubagents` — fully parsed and typed, but `index.ts` never passes a `path` into `store.createRun()`, so every run is depth 0 forever, and nothing ever checks `depth` against `maxDepth` or consults `allowNestedSubagents`. The entire "lineage tree / nested subagents" section of the design (§4.2) is inert scaffolding today.
- `AgentConfig.extraFields` — declared in `types.ts` but never assigned anywhere in `src/agents/agents.ts` (grepped: zero writes). Dead field from day one.
- `AgentConfig.frontmatterFields` — assigned once (`new Set(Object.keys(frontmatter))`, `src/agents/agents.ts:186`) with a comment claiming it's "for override merging", but `src/agents/overrides.ts` uses its own explicit `OVERRIDE_FIELDS` whitelist and never reads `frontmatterFields`. Dead computed data, and being a `Set` means if this object is ever `JSON.stringify`'d (e.g. for logging or the run store) it silently serializes to `{}` — a latent footgun even though it's unused today.

This is a real answer to "is types.ts's 587 lines load-bearing" — a meaningful fraction (lineage tree, budgets, acceptance criteria, worktree, onBlocked, fallbackModels, extraFields) is speculative surface for features described in the design doc but not wired into the P1 implementation. It inflates the contract every module must type-check against without paying for itself yet.

### M3. Thinking-suffix level list is duplicated in two files with no shared source
- `src/runs/args.ts:13`: `THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]`
- `src/agents/model-scope.ts:13`: `THINKING_SUFFIXES = new Set(["off","minimal","low","medium","high","xhigh","max"])`
- These are currently identical, but they encode the same domain fact (which suffixes are valid "thinking levels") independently, in two different modules, with two different container types (array vs Set). They are used for two different operations — `applyThinkingSuffix` (args.ts, appends) vs `splitThinkingSuffix`/`stripThinkingSuffix` (model-scope.ts, strips for glob-matching) — so this is not the "implemented twice with different semantics" bug the prompt asked me to check for (the semantics genuinely differ: append vs strip), but it **is** an unnecessary duplication: if a new thinking level is ever added, it must be updated in two places or model-scope matching and arg-building silently disagree on what counts as a "known suffix". Should be a single exported constant in one shared module (e.g. `shared/types.ts` or a new `shared/thinking.ts`) that both `args.ts` and `model-scope.ts` import.

### M4. Two different `ownerToken`-generation implementations with different quality
- `src/runs/orchestrator.ts:58`: `Math.random().toString(16)…` — **not cryptographically secure**, used for the in-memory token that (per C1) never actually reaches disk.
- `src/runs/store.ts:43`: `randomBytes(8).toString("hex")` — correct, crypto-safe, but only exercised when the incoming child record's `ownerToken` is falsy — which, because of the `"pending"` bug, never happens in the real `index.ts` code path (only in direct `RunStore` unit tests, e.g. `test/unit/store.test.ts:272`).
- Given ownerToken's stated purpose ("proves ownership, guards against killing others' panes" — design §4.1), the weak generator is the one that's actually live, and it's not even used for anything downstream today (see C1). Consolidate to one implementation (the crypto-safe one) and make sure it's the one that ends up persisted.

## MINOR — dead exports / duplication

Verified via grep across `src/`, `test/`, `index.ts`, `scripts/` (each item below has zero references outside its own defining file, except test-only references where noted):

- `formatAgentList` (`src/agents/agents.ts:354`) — **fully dead**, never called anywhere, not even in a test. `index.ts` reimplements near-identical formatting logic locally in `listAgents()` (`index.ts:271-278`). Either delete `formatAgentList` or have `index.ts` use it instead of duplicating the format string.
- `encodeNestedPath` (`src/shared/nested-path.ts:64`) — never called outside its own file. Supports the inert lineage feature (see M2).
- `parseNestedPathEnv` (`src/shared/nested-path.ts:69`) — same: never called outside its own file. Both exist as a matched encode/decode pair for passing lineage through an env var, but nothing in the codebase ever sets or reads that env var.
- `providerOf` (`src/agents/model-resolution.ts:107`) — referenced only from `test/unit/agents-model.test.ts`; never called from `index.ts` or `src/runs/orchestrator.ts`. Dead in the shipped code path (parent-provider lookups in `model-resolution.ts` itself take `parentProvider` as a pre-computed input from the caller rather than deriving it via `providerOf`).
- `mapHerdrErrorCode` (`src/herdr/client.ts:37`) — exported but only self-used within the same file (`toHerdrError` at line 111). Exporting it implies an external consumer that doesn't exist; harmless but signals over-export.
- `AgentConfig.extraFields` (`src/shared/types.ts`) — declared, never assigned by the frontmatter parser (`src/agents/agents.ts`), never read anywhere. Fully inert field from day one.
- `AgentConfig.frontmatterFields` — populated once, never consumed (see M2 for the JSON-serialization footgun this creates).

## What I explicitly checked and found OK
- `readPaneDiagnostic` — **used** (`src/runs/orchestrator.ts:169`), not dead.
- `countAssistantMessages` — **used** (`src/runs/orchestrator.ts:309,321`), not dead.
- `applyOverride` — used both by `applyAgentOverrides` internally and directly by tests; not dead.
- `isSafeNestedPathId` / `sanitizeNestedPath` — used within `nested-path.ts` itself and by tests; the *module* as a whole is unused by production code (see M2) even though the individual functions call each other.
- `createMissingBinaryRunner` — test-only helper, correctly test-only per the W4 ownership spec; not a design problem.
- `HerdrClient` methods `paneGet`, `paneProcessInfo`, `tabRename`, `tabList`, `agentList`, `version` — implemented and exercised by unit tests, but never called from `orchestrator.ts` or `index.ts`. Not "dead" (they're a documented wrapper surface), but worth flagging as speculative breadth beyond what P1 orchestration actually uses — noted, not counted as a separate finding since it's borderline by design (a client wrapper is expected to expose the full CLI).
- `applyThinkingSuffix` (args.ts) vs `splitThinkingSuffix`/`stripThinkingSuffix` (model-scope.ts): confirmed these are **not** a duplicate-implementation bug — they do genuinely different things (append a suffix vs. strip one for comparison) and are each used correctly in their own module. The only real issue is the duplicated level list (M3).

## Priority summary
1. **Fix C1** (ownerToken bug) — trivial fix, real security/audit implication.
2. **Fix C2** (continue/resume unimplemented) — either implement or reject these actions explicitly instead of falling through to a misleading error.
3. **Address M1** — let `Orchestrator` be the single source of truth for `ChildRecord` construction; have `index.ts` consume it rather than rebuild it.
4. Consider trimming M2's speculative fields out of the P1 contract (or explicitly document them as "reserved for P2/P3, not enforced yet" in code comments so future readers don't assume they work).
5. M3/M4 are quick dedup fixes.
6. Minor dead-code list: safe to delete `formatAgentList`, `encodeNestedPath`, `parseNestedPathEnv`, `extraFields`, `frontmatterFields`, or wire them up if intended for near-term use.
