# Worker report: named `subagents.presets`

## What was done

Implemented the frozen plan `/root/code/herdr-subagents/reports/presets-plan.md` exactly
(§5 signatures unchanged; §2 precedence decision implemented as written). Two commits on
branch `pi-subagent/worker-0-10b6e987`.

Files changed (11):
- `src/shared/types.ts` — `PresetConfig`; `SubagentsSettings.presets?`; `AgentConfig.preset?` (next to `model`); `"preset"` added to `ModelSourceInfo.type`.
- `src/agents/presets.ts` (NEW, pure) — `parsePresets`, `resolvePresetName`, `requirePreset`, `assertKindModelCoherent`, `applyPreset` with exact §5 signatures. Coherence guard reuses `nativeModelFor` from `src/runs/kind.ts` (no re-implemented shape test).
- `src/agents/settings.ts` — `parseSubagentSettings` reads + assigns `presets` via `parsePresets` (whitelist); `resolveSubagentSettings` shallow-merges presets exactly like `herdr`.
- `src/agents/agents.ts` — `applyModelFields`: `setIf(config, "preset", str(fm.preset))`.
- `src/agents/overrides.ts` — `"preset"` added to `OVERRIDE_FIELDS`.
- `src/agents/model-resolution.ts` — optional `presetModel?: string` on `ResolveModelInput`, inserted as candidate immediately after `override` (new level 2); no other candidate reordered; header comment updated.
- `index.ts` — optional `preset` param on `TaskItem` and `SubagentParams` (description "Named kind+model+thinking preset"); `preset` threaded through `buildPlan`/`PlanStep`/single-launch step mirroring `model`; `resolveStepModel` resolves the preset name (tool > agentOverrides-folded > frontmatter), `requirePreset`, `applyPreset` onto a COPY, `assertKindModelCoherent`, passes `presetModel` to `resolveModel`; the PRESET-PATCHED agent (carrying preset `kind`) is what reaches `orchestrator.launch`. Undefined preset throws → caught by `launchStep` and rendered as a `✗` refusal line (never silent fallback). No-preset path passes the original agent object through unchanged.
- `src/api.ts` — re-export of the presets module (functions) and `PresetConfig` type, matching existing style.
- `README.md`, `docs/design.md` — presets documented; design §6.2 precedence list updated with the new level 2.

## Test coverage

- NEW `test/unit/presets.test.ts` (14 tests): parsePresets accept/reject (non-object value/entry, unknown kind, empty model, bad thinking; `thinking:false` kept); `resolvePresetName` precedence; `requirePreset` error text names defined presets / "None are defined."; `assertKindModelCoherent` rejects cursor+pi-shaped-model, accepts pi and cursor-slug and undefined model; `applyPreset` replaces kind/model/thinking atomically, copies the agent, records `modelSource.type === "preset"`, no provenance claim when the preset has no model.
- `test/unit/agents-model.test.ts`: preset beats `agentOverrides` (level 2); preset beats provider-scoped override; tool `model` still beats preset; no-preset chain bit-for-bit unchanged; whitelist test — `presets` survives `parseSubagentSettings`, with a twin test explicitly asserting unknown keys ARE silently dropped (the behaviour being relied on); presets shallow-merge across user/project; project-without-presets keeps user's; `applyOverride` honours `preset`.
- `test/unit/agents.test.ts`: frontmatter `preset:` parsed onto config; absent preset stays absent; `preset` not reported as unenforced.
- `test/unit/kind.test.ts`: direct coverage for `isPiShapedModel`, `applyThinkingSuffix`, and the coherence guard (cursor + `cb/kimi-k3` throws, pi accepts) — these previously had zero direct coverage.

## Verification output (raw)

### Acceptance: `npm run typecheck && npm test && npm run test:integration`

```
> @zzjcool/pi-herdr-subagents@0.6.1 typecheck
> tsc --noEmit

(unit tests) 1..378
# tests 378
# pass 378
# fail 0
# duration_ms 2295.532077

(integration) 1..80
# tests 80
# pass 80
# fail 0
# duration_ms 482.199767
```

All three green. No pre-existing failures.

### Hand-verification (preset wins over agentOverrides)

Script (`node --experimental-strip-types`) exercising the exact resolveStepModel path:
settings = `{ presets: { strong: { kind: "pi", model: "cb/kimi-k3" } }, agentOverrides: { scout: { model: "cb/deepseek-v4.1-flash" } } }`,
agent `scout` with `preset: "strong"`; agentOverrides folded into agent.model first (as index.ts does).

```
folded agent.model (agentOverrides): cb/deepseek-v4.1-flash
preset name resolved: { name: 'strong', source: 'preset' }
effective kind: pi
resolved model: cb/kimi-k3
resolved source: { type: 'preset', model: 'cb/kimi-k3' }
OK: preset 'strong' beats agentOverrides.scout.model
```

## MR / branch

- Branch: `pi-subagent/worker-0-10b6e987`, pushed to origin.
- PR could NOT be opened programmatically: no `gh` CLI and no GitHub API token in this
  environment. The repo's GitHub "compare" URL (the only available channel) is:
  https://github.com/zzjcool/pi-herdr-subagents/pull/new/pi-subagent/worker-0-10b6e987

## Deviations / open issues

- One addendum to the plan, fully within its §4 decision: the plan did not specify whether the
  §4 loud undefined-preset error should throw or degrade. Since `launchStep` is documented to
  never throw, the thrown error is caught there and rendered as a `✗ <agent>: Preset 'x' is not
  defined in subagents.presets. Defined: ...` refusal line — loud and actionable, other steps
  still launch. No silent fallback anywhere.
- Everything else matches the frozen plan. No files outside the authorized list were touched;
  `~/.pi/agent/settings.json` is untouched by any code path.
