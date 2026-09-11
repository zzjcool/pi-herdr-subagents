# Adversarial Review — Test Coverage & Test Quality

Scope: everything under `test/`, cross-checked against `docs/design.md` (F1-F33) and
`src/runs/orchestrator.ts` / `src/shared/session.ts`. All 165 unit tests and 20
integration tests pass (`npm test`, `npm run test:integration`) as of this review.
Findings below are ordered by severity; #1 and #2 are backed by throwaway probes run
against the real (non-faked) code paths, not just code reading.

---

## CRITICAL

### 1. `collect()` on an already-finished turn blocks for the full timeout in production — untested, and the test harness's fake `sleep` masks it

`src/runs/orchestrator.ts` `collect()` (around line 297-330):

```ts
const before = countAssistantMessages(parseSessionFile(child.sessionFile));
// Phase 1: wait for the turn to actually start producing output.
for (let poll = 0; poll < maxPolls; poll += 1) {
  const parsed = parseSessionFile(child.sessionFile);
  if (countAssistantMessages(parsed) > before) { progressed = true; break; }
  if (this.now() >= deadline) break;
  await this.sleep(this.pollIntervalMs);
}
```

`before` is computed by reading the session file **at the moment `collect()` is
called** — so if the turn already finished (the exact "collect() when the turn
already finished before collect is called" case this review was asked to check),
`before` already equals the final assistant-message count. `progressed` then never
becomes `true` (nothing NEW gets appended), so the loop **never returns early** — it
spins until `this.now() >= deadline`, i.e. until `opts.timeoutMs` (default
`DEFAULTS.turnTimeoutMs = 900_000` ms = 15 minutes) elapses, using the REAL
`setTimeout`-based `defaultSleep` in production.

I verified this directly (probe, not from the test suite):

```
result.execution.status = success
opts.timeoutMs was 2000ms; elapsed real ms = 2005
```

i.e. calling `collect()` right after writing a *complete, already-finished*
transcript still blocks for the entire configured timeout before returning the
(already-known) answer. With the documented default of 900_000 ms, this means
**every `collect()` call issued after the turn has already settled — which is
exactly the common case when a caller polls status first, or re-collects after a
crash/restore — blocks for up to 15 minutes** instead of returning immediately.

**Why the test suite doesn't catch this**: every integration test that exercises
`collect()` (`test/integration/orchestrator.test.ts` lines ~200-268) writes the
transcript file *before* calling `collect()`, i.e. they all hit precisely this
"already finished" case. But the harness's injected `sleep` is:

```ts
sleep: async (ms) => { fake.advance(ms); }
```

This does **not** actually wait — it just bumps a fake clock field and resolves on
the next microtask. Meanwhile `this.now()` in `Orchestrator` defaults to real
`Date.now()` (the harness never overrides `now`), so the deadline check
`this.now() >= deadline` is compared against **real** wall-clock time while `sleep`
consumes **no** real wall-clock time. The result: the full ~1810-iteration poll loop
(`maxPolls = ceil(900_000/500)+10`) runs back-to-back with no real delay and
finishes in a couple of milliseconds — which is why these tests report `duration_ms:
~1-2` and pass instantly. **The fake sleep hides the exact bug it should be
surfacing.** This directly relates to review requirement #3 ("verify the injected
sleep cannot cause a hang") — it doesn't cause a hang in the test suite, but that's
because the fake breaks the now()/sleep() coupling that the real `Orchestrator` relies
on, not because the underlying logic is correct.

**Fix direction**: Phase 1 should short-circuit when the session is already in a
terminal state (e.g. `deriveOutcome` on the current snapshot is not `"unknown"`/mid-turn
and the file hasn't grown since child launch), not just poll for message-count growth.
Alternatively, `collect()` needs a "was this session already complete at entry" fast
path. A regression test should use a harness where `now` is tied to the same fake
clock as `sleep` (or asserts on `Date.now()` deltas with a very small `timeoutMs`) so
a slow-`collect` regression fails loudly instead of appearing fast.

### 2. `ExecutionStatus.running` is dead code — the "task genuinely still in progress" case is untested and likely mis-reported as `"aborted"`

`src/shared/types.ts` defines `ExecutionStatus` to include `"running"` ("尚未结束" /
"not yet ended", per design §3.2), but `deriveOutcome()` in `src/shared/session.ts`
has **no branch that ever returns `"running"`**. Its only two "no final answer yet"
outcomes are:
- `turns.length === 0` → `"unknown"`
- last turn has a user message but no assistant reply yet → `"aborted"` (the F29
  hard-kill signal)

These two cases are indistinguishable from "the child hasn't replied to the last
prompt yet because it is still thinking" (a live, in-progress turn) — but the second
one is coded as `"aborted"`, not `"running"`. If `orchestrator.collect()` hits its
deadline for a task that is legitimately still slow-running (no `progressed`, no
crash), it will call `deriveOutcome` on a transcript whose last turn has a user
message and no assistant reply yet, and get `"aborted"` back — even though nothing
was actually aborted. This conflates "the process was killed mid-turn" (F29's actual
finding) with "we gave up waiting" (a orchestrator-side timeout), which is a
**correctness/semantics bug in the making** and is completely untested — no test in
`session.test.ts` or `orchestrator.test.ts` exercises "collect() timeout while the
agent is still legitimately working."

---

## MAJOR

### 3. `collect() timeout behaviour` is unspecified by any test that actually elapses time

Per the design's own required-case list (`docs/design.md` §13 acceptance cases) and
this review's checklist, there is no test that:
- Calls `collect()` with a short `timeoutMs` against a session that never produces a
  reply, and asserts the returned status/behavior at timeout (vs. hanging or
  throwing).
- Distinguishes "we timed out, the turn may still be running" from "the turn was
  aborted." Given finding #2, this is not an oversight — the code doesn't have a
  distinct path to test.

### 4. F19 race is only tested with 1-2 concurrent starts against the SAME orchestrator instance, not the multi-child scramble the design worries about

`test/unit/herdr-client.test.ts` "agent_pane_busy race after split, retry succeeds"
uses a single pane/single start. `test/integration/orchestrator.test.ts` "launch
retries agent_pane_busy until the pane is ready (F19)" also launches a single child.
Nowhere is there a test that launches ≥3 children **concurrently** (`Promise.all`)
against a busy-pane window and asserts all succeed with distinct names — the
scenario F19/F20 in design.md actually measured (`exp7-H1`: 2/6 failed without
retry; `exp8-A`: 6/6 succeeded with retry). I ran this as a probe (5 concurrent
`launch()` calls, `paneBusyMs: 200`) and it passed — but this exact scenario is
**absent from the committed test suite**, so a regression in `startWithRetry`'s
interaction with concurrent callers (e.g. shared backoff state, `allocateName`
collisions under real interleaving) would not be caught by CI.

Note: `allocateName()` is called synchronously (no `await` before it) inside
`launch()`, so for calls issued via `Promise.all` on a *single* `Orchestrator`
instance, JS's run-to-completion semantics mean name allocation is effectively
serialized before any interleaving occurs — this is a mitigating factor, but it's
also exactly the kind of subtlety that should be pinned down by an explicit test
rather than left as an implicit consequence of event-loop scheduling.

### 5. `retire()` on a child whose agent already exited independently — no dedicated unit/integration test

`test/integration/orchestrator.test.ts` "retire is idempotent" retires a child
*through the orchestrator itself* twice — it never tests the case where the
**underlying herdr agent exits out-of-band** (crashed, hit its own idle-exit, or was
killed by something else) before `retire()` is called from our side. I probed this
directly: deleting the fake agent registry entry before calling `retire()` — it
worked correctly (used the session file to derive `execution`, didn't throw on
`agentGet`/`agentSendKeys` failing). So the *implementation* appears robust (it
`.catch(() => undefined)`s the send-keys/paneClose calls), but this exact
robustness is **not asserted by any test** — a future regression that removes those
`.catch()` guards, or that fails to snapshot `execution` before probing liveness,
would not be caught.

### 6. `launch()` pane-split-succeeds-but-agent-start-fails rollback is only tested for the "retries exhausted" (`PANE_BUSY`) variant, not a hard non-retryable failure

The only rollback test, "a failed launch rolls back its pane instead of leaking it,"
constructs failure via `paneBusyMs: 10_000` + `sleep: async () => {}` (never
advances) so retries exhaust. It does **not** test the other rollback branch in
`startWithRetry` — a non-`PANE_BUSY` error (e.g. `agent_name_taken`,
`agent_start_timeout`) that throws immediately without retrying. I probed this
(pre-registering a colliding agent name) — rollback worked (pane count unchanged
after the failed launch) — but again, **no test asserts it**. Given this is a
distinct code path (`if (res.error.code !== ErrorCodes.PANE_BUSY) throw ...` at
`orchestrator.ts` ~187), it deserves its own test independent of the retry-exhaustion
one.

### 7. Usage accumulation is only tested for 3 assistant messages within a single turn — no test for accumulation across MANY turns (as requested by review checklist)

`session.test.ts` "usage accumulation across 3 assistant messages" is all within one
turn (no intervening `userMsg`). There's no test with e.g. 10+ turns each
contributing usage, verifying the running total in `ParsedSession.usage` survives
turn boundaries (it should, since `accumulateUsage` writes to `parsed.usage`
directly rather than per-turn — but this cross-turn behavior is unverified).

### 8. "Last turn is a tool error but an earlier turn succeeded" (inverse of F31) — untested

The suite has the F31 case ("turn1 tool error, turn2 clean stop → success") but not
the inverse the review explicitly asked about: **turn1 succeeds cleanly, and the
LAST turn ends in a tool/assistant error**. Per F31 ("only the last turn decides
success"), this should yield `"failed"` even though an earlier turn was fine — a
plausible regression target (e.g. if someone "fixes" the code to OR turn outcomes
together) that no test would catch.

---

## MINOR / test-quality nits

- **`test/helpers/fake-herdr.ts` turns resolve synchronously** (`runTurn`'s `finish()`
  is called immediately, no real async gap) — reasonable for determinism, but it
  means most orchestrator integration tests never exercise the fake's own
  `scriptTurns`/`steerable` machinery at all; they bypass it entirely by
  `writeFileSync`-ing the session file directly and letting `collect()`'s polling
  loop discover it. That's fine for testing `deriveOutcome` wiring, but it means the
  fake's `agent prompt` "steering while working" queueing/`steerable` path
  (`fake-herdr.ts` lines ~420-432) is exercised by exactly one indirect probe I ran
  manually — not by any committed test. `steer forwards a prompt to a live child
  (F10)` in `orchestrator.test.ts` steers an **idle** agent (post-launch, before any
  turn starts), not a `working` one — so it doesn't actually prove steering-while-busy
  behaves differently from a normal queued prompt. This is a **tautological-ish
  test**: it would pass identically if `steer()` just called `agentPrompt` on any
  agent state, without any F10-specific "accept while working" semantics being
  implemented at all.
- `fake-herdr.ts` is otherwise a faithful, well-commented model of the measured wire
  format: JSON-on-stdout for success / JSON-on-stderr for errors with empty stdout
  (F21), `agent_session: null` for non-pi kinds (F7), `ctrl+d` vs `ctrl+c` exit
  semantics (F11), name-taken-while-alive/freed-on-exit (F16), pane-busy timing
  window (F19), plain-text (non-JSON) `pane read` (F6), and atomic `tab close`
  reaping (F15). I did not find any place where the fake's wire shapes contradict
  `docs/design.md`'s findings — this part of the harness is solid and is the
  highest-value piece of infrastructure in the suite, matching the review priority.
- `parseSessionFile` on a **missing** file is tested; parsing an **existing but
  empty** file (the F4 pre-created-session-file state) is only indirectly covered
  (store tests assert file existence/size/mode, not what `parseSessionFile`/`deriveOutcome`
  return for that exact file). Worth an explicit `session.test.ts` case since it's the
  state every freshly-launched child starts in.
- `test/integration/orchestrator.test.ts`'s "auditOrphans reports panes..." test is
  slightly weak: it asserts `orphans.length >= 1` rather than asserting the *specific*
  orphan pane ID is the one returned — a bug that also flagged the *child's own* pane
  as an orphan would still pass.

---

## Verified (no issues found)

- `npm test` (165 tests) and `npm run test:integration` (20 tests) — all pass, ~300ms
  and ~400ms respectively. No flakiness observed across two runs.
- `parseSessionFile` missing-file case: covered and correct (returns
  `emptyParsedSession()`, no throw).
- `deriveOutcome` core stopReason mapping (`stop`/`length`/`toolUse`/`error`+abort
  detection/unknown) is well covered by table-driven tests matching F26-F31 exactly.
- `extractVerdict` (F33) — bare JSON, fenced JSON, textual `FAILED:` convention, and
  negative cases (plain text, non-verdict JSON, empty string) are all covered and are
  genuine assertions on parsed structure, not just "doesn't throw."
- `RunStore` (W2) — atomic writes, corrupt-file quarantine, prune by age/size, name
  sanitization against traversal — all well covered with 25+ meaningful tests; the
  concurrent `updateRun`/`addChild` tests (30 and 10 parallel calls) genuinely prove
  the mutex prevents lost updates (assert final counts, not just "didn't throw").
- `herdr-client.test.ts`'s `parseHerdrResponse` table (stdout/stderr JSON precedence,
  error-code mapping, ENOENT → `HERDR_UNAVAILABLE`) matches F21/F22 exactly and is
  tested against real return shapes, not mocks-of-mocks.

---

## Summary

The suite is generally well-designed against the measured findings, and the fake
herdr wire format is trustworthy. But the two most operationally important
`collect()`/`retire()` code paths this review was asked to check — **collect() on an
already-finished turn** and **the "still legitimately running" vs "aborted"
distinction** — are not just undertested, they expose a real production bug
(unbounded blocking up to the 15-minute default timeout) that the test harness's
non-time-advancing fake `sleep` actively conceals. Recommend prioritizing #1 and #2
before shipping; #4-#6 are test-debt that should be closed to lock in the
already-correct rollback/idempotency behavior I confirmed by hand.
