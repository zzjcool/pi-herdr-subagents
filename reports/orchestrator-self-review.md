# Orchestrator self-review (adversarial pass)

Findings from my own review of the delivered code. Severity:
**critical** = wrong behaviour / data loss; **major** = design gap, real consequence;
**minor** = cleanup.

## Fixed during review

| # | Sev | Finding | Fix |
| --- | --- | --- | --- |
| 1 | **critical** | `Orchestrator.collect()` returned instantly with 0 turns. `agent wait` matches any *settled* state, so when called right after launch (agent idle, turn not started) it resolved immediately and derived `unknown`. Found by end-to-end testing against real herdr. | Two-phase wait: poll the session file for actual assistant-message progress, then `agent wait` + a quiet window. `src/runs/orchestrator.ts` |
| 2 | **critical** | `waitForQuiet()` looped on wall-clock while the injected `sleep` was instant ⇒ tight infinite loop. Integration suite hung. | Bounded by an iteration cap as well as the deadline. |
| 3 | **critical** | `launch()` ignored `agent.model`, so an agent's frontmatter model was silently dropped. Verified: requested `cb/glm-5.3-flash`, child actually ran `deepseek-v4.1-flash`. | `model: input.model ?? input.agent.model`. |
| 4 | **major** | `extractVerdict()` only understood JSON, so an agent reporting `FAILED: ...` (the exact F32 case in the design) was scored `success` with no acceptance signal. | Added a strict first-line `FAILED:` textual convention. |
| 5 | **major** | `list()` in `agents.ts` did not handle YAML flow arrays: `tools: [read, bash]` parsed as `["[read", "bash]"]`. Caught by the test suite. | Strip surrounding brackets before splitting. |
| 6 | **minor** | `tabId` from `createPane` was discarded, so per-child tabs could not be audited or reaped. | Recorded on `ChildRecord.tabId`. |

## Open findings (not fixed — reported for the record)

### O1 — Lineage tree is defined but never wired (major)

`docs/design.md` §4 specifies a three-layer tree (lineage / ownership / resource) and
`NestedPathEntry` is implemented with a sanitiser. But:

- nothing reads the parent's lineage from the environment,
- `launch()` passes no lineage to the child,
- `maxSubagentDepth` / `allowNestedSubagents` are parsed from frontmatter and then
  **never enforced**.

Consequence: nested subagents are unlimited, and the "prevent cycles / bound depth"
property the design claims is not actually in force. The data structures are correct;
the wiring is missing. This is the single largest gap between design and code.

### O2 — Children inherit full herdr access (major, accepted limitation)

Documented as F23–F25 and called out in the README. A child can run
`herdr pane read <any-pane>` and see other panes' contents. The design's answer is
tab-boundary + orphan audit + prompt discipline; `auditOrphans()` is implemented but
**never called** by any code path. So even the detection half is currently inert.

### O3 — Thinking-level list duplicated (minor)

The set of valid thinking levels exists twice with independent literals:
`THINKING_SUFFIXES` in `src/agents/model-scope.ts` and `THINKING_LEVELS` in
`src/runs/args.ts`. They agree today; they can drift. One should import the other.

### O4 — Dead exports (minor)

Verified unused outside their own module and tests:

- `formatAgentList()` (`src/agents/agents.ts`)
- `encodeNestedPath()` / `parseNestedPathEnv()` (`src/shared/nested-path.ts`) —
  only meaningful once O1 is wired
- `providerOf()` (`src/agents/model-resolution.ts`) — only used by its test
- `emptyParsedSession()` is exported but only used internally

### O5 — `collect()` on an already-exited agent (minor)

If the agent has exited, `agent wait` returns `NOT_FOUND`. `collect()` treats that as a
hard error rather than falling back to reading the session. In practice `retire()`
snapshots the outcome, so this is not hit by the current control flow — but a direct
`collect` after a crash would throw instead of reporting the last known outcome.

### O6 — `usage` in `CollectResult` is never null (minor)

The declared type is `Usage | null`, but `parseSessionFile` always returns a zeroed
`Usage`. The `| null` is dead; harmless but misleading.

## Verified-good (probed, not assumed)

Probes in `/tmp/probe-collect.ts` against the fake herdr, all passing:

| Probe | Result |
| --- | --- |
| collect when the turn already finished before the call | `success`, 2ms, output correct |
| collect when the turn never produces output | bounded, returns `unknown` (no hang) |
| collect when the last assistant message is `toolUse` (killed mid-tool) | `aborted` |
| earlier turn errored, last turn succeeded (F31) | `success` |

Also verified by direct execution:

- `npm run typecheck` clean; 165 unit + 20 integration tests pass.
- End-to-end against **real** herdr + real pi child: launch → collect → retire,
  `execution=success`, correct output, real token usage, session file survives retire.
- All 5 bundled agent definitions parse; `reviewer` is read-only (no edit/write tools).
