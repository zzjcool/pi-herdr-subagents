# W4 — test harness

## Delivered

| File | Purpose |
| --- | --- |
| `test/helpers/fake-herdr.ts` | In-memory herdr simulator + `CommandRunner` adapters (`createFakeRunner`, `createMissingBinaryRunner`). Reproduces the measured races/behaviours F1, F6, F7, F11, F15, F16, F19, F21, F22. |
| `test/helpers/fixtures.ts` | Session-jsonl builders: `sessionHeader()`, `modelChange()`, `userMsg()`, `assistantMsg({stopReason,text,tools,errorMessage,usage})`, `toolResult({isError})`, `tornLine()`. |
| `test/helpers/tmp.ts` | `withTempDir(fn)` — mkdtempSync/rmSync scoped helper. |
| `test/unit/session.test.ts` | 24 tests for `parseSessionText` / `parseSessionFile` / `deriveOutcome` / `extractVerdict`. |
| `test/unit/herdr-client.test.ts` | 23 tests for `parseHerdrResponse` / `createHerdrClient` / name & nested-path utilities. |

### Measured behaviours modelled in the fake (as required)

- **F19** — `paneBusyMs` option: panes reject `agent start` with `agent_pane_busy` for the
  first N ms after a split; tests advance the fake clock (`fake.advance(ms)`) past the window
  and assert the retry succeeds. Fully deterministic (no real sleeping).
- **F21** — every error path emits `{"error":{code,message}}` on **stderr with empty stdout**
  and exit code 1; success payloads are `{"result":...}` on stdout with code 0.
- **F16** — `agent_name_taken` while a name is alive; the name is freed when the agent
  exits (ctrl+d, prompt-exit script, or pane/tab close).
- **F7 / F1** — `agent start` returns `agent_session.value` = session path for `kind: "pi"`;
  non-pi kinds return `agent_session: null`.
- **F11** — `agent send-keys ctrl+d` exits the agent; `ctrl+c` leaves it alive. Both asserted.
- **F22** — missing binary runner returns the ENOENT shape (code −1 + stderr), mapped to
  `HERDR_UNAVAILABLE`; also asserted that an `*_timeout` error code maps to `START_TIMEOUT`.
- Also modelled: F6 (`pane read` = plain text), F12 (pane close kills agent, names freed),
  F15 (`tab close` atomically clears panes+agents), F10 (steering prompts recorded).

## Tests (count + what they cover)

47 tests total (24 session + 23 client), all mandatory rows from both IMPLEMENTATION.md
tables implemented:

**Session** — success turn; `error`→failed w/ preserved message; `error`+aborted→aborted (F29);
`length`→truncated; `toolUse` last→aborted; user msg w/o reply→aborted+`lastTurnMissing` (F29);
no messages→unknown; turn1 tool error + turn2 clean stop→success & `toolErrors:1` (F30/F31);
torn line counted, no throw (F12); usage accumulation over 3 assistant msgs (input/output/
cacheRead/cacheWrite/cost); unknown stopReason→failed with reason; verdict JSON / plain text /
```json fence (F33). Supplementary: missing-file→empty parse, file round-trip, F32 self-report
(still `stop` mechanically, caught by verdict), turn boundary independence, orphan
toolResult before any user msg.

**Client** — stdout success parse; stderr error parse (F21); non-JSON garbage→PARSE_ERROR /
HERDR_ERROR; `agent_pane_busy`→`PANE_BUSY`; `agent_name_taken`→`NAME_TAKEN`; ENOENT→
`HERDR_UNAVAILABLE`; start-timeout code→`START_TIMEOUT`; `makeName("Review Agent",1)`→
`review-agent-1`; `makeName("9bad",0)` letter-first ≤32; `makeName("x"×50,3)` ≤32 & valid;
`isSafeNestedPathId("../../etc")`→false (+ `/`, `\`, empty); `sanitizeNestedPath` >4→4;
junk entries dropped; plus fake-driven: F1 session path, F7 null session for cursor,
F19 race + retry, F16 name lifecycle, F11 ctrl+d vs ctrl+c, F6 pane read text,
F15 tab close, arg forwarding, `available()` probe, `resolveHerdrBin` env.

## Verification output

```
$ npm run typecheck
> tsc --noEmit
(no errors — clean)

$ npm test
# tests 165
# pass 165
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 329.32902
```

My subset in isolation:

```
$ node --experimental-strip-types --test test/unit/session.test.ts test/unit/herdr-client.test.ts
# tests 47
# pass 47
# fail 0
```

(165 total includes other workers' tests; my contribution is 47. Baseline before my work:
56 tests, and typecheck had 3 pre-existing errors in `index.ts` — since fixed by another worker.)

## Open questions / deviations

1. **Spec/code mismatch — `deriveOutcome` "turns" of unknown case**: the spec table says
   "no messages at all → `unknown`"; implementation matches. No conflict found.
2. **Spec/code mismatch (minor) — `extractVerdict` returns `reason` whenever present**,
   e.g. a fenced `{"ok":true}` with a reason comes back with `reason` included. The spec
   table only pins `{"ok":false,"reason":"x"}`, which matches. Not a conflict, but W-tests
   assert the richer shape, so orchestrator code must not assume `reason` is absent on `ok:true`.
3. **Observation — `parseHerdrResponse` prefers stdout over stderr** when both parse.
   F21 says errors live on stderr with empty stdout, so this is safe today; if herdr ever
   emits a payload on both streams, stdout wins. Test `agent_pane_busy → PANE_BUSY` pins
   the empty-stdout error shape so a regression would be caught.
4. **Fake simplifications (documented, deliberate)**: turns resolve synchronously on the
   fake clock (`agent wait` returns immediately once scripted); no real process spawning.
   Enough for the orchestrator's retry/name/recycle logic, not for wall-clock timing tests.
5. **`runTurn` does not append to session files** — the fake simulates session content via
   fixtures in the session tests instead. If the orchestrator wants end-to-end
   fake-start→fake-session tests, `FakeHerdr.scriptTurns` can be extended to write
   transcript lines to disk; left out to keep the fake disk-free.
