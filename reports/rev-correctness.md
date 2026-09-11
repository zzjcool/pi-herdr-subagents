# Adversarial Review — Correctness & Regression

Scope: `src/shared/session.ts` (deriveOutcome), `src/runs/orchestrator.ts` (collect/retire/launch),
`src/herdr/client.ts` (parseHerdrResponse), `src/shared/name.ts`, `src/shared/nested-path.ts`,
and the wiring in `index.ts`. All 165 existing unit/integration tests pass
(`npm run typecheck && npm test` — not re-verified at report time per stop instruction, but was green earlier in this session).

## Findings, ranked by severity

### CRITICAL — index.ts: `onChildUpdate` fires before `store.addChild`, causing an unhandled rejection on every launch

`src/runs/orchestrator.ts:245` calls `this.onChildUpdate(child)` synchronously right after a child
is registered in the orchestrator's **in-memory** map, immediately after `agentStart` succeeds —
this happens *inside* `Orchestrator.launch()`, before `launch()` has even returned to the caller.

`index.ts:151` wires:
```ts
onChildUpdate: (child) => store.updateChild(run.runId, child.name, () => undefined),
```
But the child is only added to the **on-disk** store afterwards, at `index.ts:190`
(`store.addChild(run.runId, {...})`), which runs only after `orchestrator.launch()` has
already returned and its internal `onChildUpdate` has already fired at least once.

Effect: the very first `onChildUpdate` invocation for every launched child calls
`store.updateChild(runId, name, ...)` against a run.json that does not yet contain that
child. `RunStore.updateChild` → `RunStore.updateRun` → `doUpdate` throws
`SubagentError("child not found: <name>", NOT_FOUND)` (`src/runs/store.ts:296-298`) inside a
`.then()` chain that nobody in `index.ts` awaits or catches — `onChildUpdate` is typed
`(child: ChildRecord) => void`, called fire-and-forget at `orchestrator.ts:245`. This produces
an **unhandled promise rejection** on every single successful launch.

Reproduced live (see `/tmp/probe2.mjs`, wiring `index.ts`'s exact `onChildUpdate` closure against
a real `RunStore` + fake herdr):
```
launch returned, handle: reviewer-0
REJECTED store.updateChild for reviewer-0 : child not found: reviewer-0
SubagentError: child not found: reviewer-0
    at RunStore.doUpdate (store.ts:265)
    ... unhandled promise rejection
```
Under Node's default `--unhandled-rejections=throw` (or in a long-running process where this
accumulates), this can crash the host process or silently corrupt store state depending on how
the extension host handles unhandled rejections — either way it's a bug that fires on the
**happy path of every single launch**, not an edge case.

Why the test suite didn't catch it: `test/integration/orchestrator.test.ts` never uses
`RunStore` — it exercises `Orchestrator` directly with a bespoke `onChildUpdate` stub
(harness in that file has no `onChildUpdate` at all, so it defaults to a no-op). There is no
test that wires `Orchestrator` + `RunStore` together the way `index.ts` actually does. This is
a real integration gap, not just a theoretical issue — the exact code path in `index.ts` is
unreachable from any test in the repo.

Fix direction: either (a) call `store.addChild` synchronously before constructing the
`Orchestrator` / before `launch()` can fire `onChildUpdate` (hard, since the child identity is
only known after `launch()` allocates a name), or (b) make `onChildUpdate` upsert
(add-if-missing) rather than assume the child already exists, or (c) have `index.ts` add a
placeholder child to the store immediately in `orchestrator.launch`'s caller before awaiting,
keyed by the name the orchestrator is about to allocate (requires exposing name allocation
ahead of launch), or (d) simplest: change `RunStore.updateChild` semantics to be tolerant when
called concurrently with `addChild`, or have `index.ts`'s `onChildUpdate` swallow `NOT_FOUND`.

### CRITICAL — index.ts: `retire` action never actually retires anything

`index.ts:123` routes `status`, `collect`, and `retire` through the **same** code path:
```ts
if (action === "status" || action === "collect" || action === "retire") {
    ...
    return renderChild(found.child, action);
}
```
`renderChild` (index.ts, near bottom) only reads fields off the persisted `ChildRecord` and
formats them as text — it never calls `orchestrator.retire(name)`, never sends `ctrl+d`, never
closes the pane, never updates `child.state` to `"retired"`. There is also no `Orchestrator`
instance available in this branch at all — the `Orchestrator` is only constructed later, inside
the "launch-family actions" section (`index.ts:147`), for the `launch`-path steps.

Consequence: calling the tool with `action: "retire"` is a complete no-op against herdr — the
pane stays open, the agent keeps running, `child.paneId` is never nulled, and `run.json` never
records `retiredAt`. This directly contradicts the design's hardest requirement (design.md
§4.2.1 / §5.2 step 4: "retire MUST snapshot execution before recycling, then actually recycle").
Every design claim about "no condition cleanup", "pane leak prevention", and F27's outcome
snapshot depends on `Orchestrator.retire()` actually running — and the tool surface never calls
it. `Orchestrator.retire()` (a well-built, well-tested method per
`test/integration/orchestrator.test.ts`) is effectively dead code from the tool's perspective.

Same applies to `continue`, `steer` (steer is at least wired via `client.agentPrompt` directly,
bypassing `Orchestrator.steer` entirely — functionally OK but inconsistent) and `resume`, which
have no handling branch in `index.ts` at all — they fall through to "launch-family actions"
since only `list`/`status`/`collect`/`retire`/`steer` are special-cased, meaning `action:
"continue"` or `action: "resume"` silently behaves like a fresh `launch`, discarding session
continuity entirely. This is a major regression against the design's core state machine
(§3.3/§3.3.1) which treats `continue`/`resume` as distinct from `launch`.

### MAJOR — `deriveOutcome`: literal `stopReason: "aborted"` is misclassified as `failed`

`StopReason` (frozen in `src/shared/types.ts`) includes `"aborted"` as a valid enum value, and
`Execution.stopReason` is typed to carry it. But `outcomeFromFinalMessage`
(`src/shared/session.ts`, the `switch` under `outcomeFromFinalMessage`) has cases only for
`"stop"`, `"length"`, `"error"`, `"toolUse"` — there is **no case for `"aborted"`**, so it falls
into the `default:` branch and returns:
```
{ status: "failed", stopReason: "aborted", reason: "unknown stopReason: aborted", ... }
```
Verified live:
```js
deriveOutcome(parse(... stopReason:"aborted" ...))
// => {"status":"failed","stopReason":"aborted","reason":"unknown stopReason: aborted", ...}
```
F29 claims pi never actually writes `"aborted"` in practice, so this may never trigger against
real pi output today. But: (1) the type system explicitly allows it — any future pi version, or
any other AgentKind's session-like output, that does write it will be silently reported as
`"failed"` instead of `"aborted"`, which is a **wrong bucket**, not just an "unknown" bucket; (2)
this is exactly the kind of one-line gap adversarial/fuzzed inputs would hit. It should be an
explicit `case "aborted": return { status: "aborted", ... }`, not fall through to `failed`
via the "unknown stopReason" catch-all. The current default-case message
(`unknown stopReason: aborted`) is also actively misleading — `"aborted"` is not unknown, it's
a known-but-unhandled value.

### MINOR — `deriveOutcome`: assistant message with `stopReason` absent (`null`/`undefined`, e.g. a torn/incomplete streamed write) is misclassified as `failed` rather than `unknown`/`aborted`

Verified live: an assistant message with `role: "assistant"`, valid `content`, but no
`stopReason` field at all produces:
```
{"status":"failed","stopReason":null,"reason":"unknown stopReason: null", ...}
```
This is plausible in practice: `parseSessionText` tolerates torn *lines* (F12, malformed JSON),
but does not defend against a **structurally valid but semantically incomplete** message — e.g.
a streaming write that flushed the message object before the final `stopReason` field was set
(depends on how pi writes JSONL; if writes are atomic per-line this can't happen, but the code
has no comment establishing that guarantee, and the session-format.md doc doesn't promise
atomicity either). Calling this `"failed"` with reason `"unknown stopReason: null"` is
misleading to whoever reads it — it reads as an LLM error, when it's actually a parse/write
irregularity. Distinguishing "we saw a real error stopReason" from "we saw no stopReason at
all" (arguably closer to the F29 "aborted" bucket, same as a fully-missing assistant message)
would be more honest.

### MAJOR (design/race) — `collect()`'s phase-1 poll can declare "progressed" on a **stale** prior turn's tail growth, not the new turn

`Orchestrator.collect()` (`src/runs/orchestrator.ts`) takes `before = countAssistantMessages(...)`
at call time and then polls until the count increases. This correctly guards against the
documented "collect called right after launch, sees old state" problem — but it does **not**
distinguish "new turn produced an assistant message" from "a `continue`/`steer` call
concurrently caused a second assistant message to land in the file while we were polling for an
unrelated reason." Since `Orchestrator` has no per-collect turn/generation token and relies
purely on message *count*, two concurrent callers (e.g. a `collect` racing a `steer` that also
provokes a reply) can observe the same count increase and both believe their own request settled
the turn — `collect` doesn't verify that the newly observed assistant message actually belongs
to the same `user` turn it expects. This is a real race in the documented "steer while working"
flow (F10) combined with `collect`, though it requires the caller to invoke `steer` and
`collect` concurrently on the same handle, which callers arguably shouldn't do — but nothing in
the API prevents it, and there's no test covering concurrent steer+collect.

### MINOR — `parseHerdrResponse`: an error object without a `.error` key but with a truthy non-JSON exit code and JSON-shaped stdout could be misread as success

`parseHerdrResponse` (`src/herdr/client.ts`) checks `fromStdout?.error` / `fromStderr?.error`
first, and only falls into the "no JSON error, treat as ok" branch when `code === 0`. Given
`code !== 0`, it correctly refuses to call it success. This path looks correct — I could not
construct an input that gets silently treated as success when it shouldn't be, given `code` is
trustworthy. Flagging as verified-clean rather than a finding (see "Verified clean" below), but
note it depends entirely on `code` being accurate; if a wrapping shell/timeout harness ever
reports `code: 0` for a killed process (common with some process-timeout implementations that
swallow the real exit code), `parseHerdrResponse` would treat truncated/garbage stdout as a
`PARSE_ERROR` at best — it does NOT have a special case for "well-formed JSON envelope missing
both `result` and `error` keys with code 0" beyond falling through to
`ok: false, code: PARSE_ERROR` — that part is fine, not a bug.

## Verified clean (no issue found)

- `src/shared/name.ts` `makeName`: tested against multiple hostile inputs (`"Review Agent"`,
  `"9bad"`, 50-char strings, empty/only-invalid-chars strings) via the existing test suite and
  manual reasoning; always anchors to `^[a-z]`, always ≤32 chars, has a hard fallback to
  `agent-<index>` if normalization ever produces something invalid. Collisions between two
  different `agent` inputs that normalize to the same base (e.g. `"Review!"` and `"Review?"`
  both → `"review"`) are NOT deduplicated by `makeName` itself, but `Orchestrator.allocateName`
  wraps it with a `this.children.has(candidate)` collision loop, so at the orchestrator layer
  collisions are handled. `makeName` alone, called directly with the same `(agent, index)` pair
  twice, will of course return the same name twice — that's expected/documented behavior, not a
  bug, since uniqueness is the caller's job (`allocateName`).
- `src/shared/nested-path.ts`: `isSafeNestedPathId` correctly rejects absolute paths, `..`,
  `/`, `\`; `sanitizeNestedPath` correctly caps at `MAX_NESTED_PATH_ENTRIES` (4) and drops
  malformed entries per-item without throwing. No bypass found (e.g. no case-normalization
  trick, no encoded-path trick, since it's pure string containment checks against raw values,
  not filesystem-resolved paths — `path.isAbsolute` on Windows-style paths on a POSIX host
  could theoretically differ, but this project appears POSIX-only per its use of `ctrl+d`/pane
  semantics).
- `F30`/`F31` (tool errors are per-turn, only last turn decides outcome): correctly implemented
  and covered by both the existing `session.test.ts` and my own manual probes.
- `retire()` (`Orchestrator.retire`, not the dead `index.ts` wiring above) correctly snapshots
  `execution` before touching the pane, in the right order, and is idempotent — confirmed via
  existing integration test "retire is idempotent" and by reading the code: it guards
  `if (!child.execution && fs.existsSync(...))` so a second retire call is a safe no-op on the
  execution snapshot.
- `launch()` rollback on failure: confirmed both by code reading and the existing integration
  test "a failed launch rolls back its pane instead of leaking it" — `paneId` is closed in the
  `catch` block before rethrow. No leak found in the retry-exhaustion path.

## Priority summary for the orchestrator to act on

1. **CRITICAL**: `index.ts` `onChildUpdate` → `store.updateChild` fires before `store.addChild`
   — unhandled rejection on every launch. Fix ordering/semantics.
2. **CRITICAL**: `index.ts` `retire` action is a no-op — never calls `Orchestrator.retire`,
   never closes panes, never persists `retiredAt`. `continue`/`resume` actions aren't routed
   either and silently behave like `launch`. This is the single biggest gap between the design
   doc and the shipped tool surface.
3. **MAJOR**: `deriveOutcome` mishandles literal `stopReason: "aborted"` (maps to `failed`
   instead of `aborted`) — add an explicit case.
4. **MINOR**: `deriveOutcome` labels a missing/`null` `stopReason` on a present assistant
   message as `failed` with a misleading "unknown stopReason: null" reason; consider bucketing
   with the F29 "no reply" abort case instead.
5. **MAJOR** (harder to fix, lower likelihood): no turn/generation token in `collect()` to
   distinguish concurrent steer-induced replies from the awaited turn's own reply.
